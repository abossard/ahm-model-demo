from urllib.parse import urljoin, urlsplit

from config import (
    AGENT_REQUEST_HEADERS,
    AGENT_RESPONSE_HEADERS,
    HOP_BY_HOP_HEADERS,
)


def connection_tokens(values):
    result = set()
    for value in values:
        result.update(
            token.strip().lower() for token in value.split(",") if token.strip()
        )
    return result


def filter_request_headers(items, connection_values):
    blocked = HOP_BY_HOP_HEADERS | connection_tokens(connection_values)
    headers = []
    for name, value in items:
        normalized = name.lower()
        allowed_extension = normalized.startswith(("x-ag-ui-", "x-copilotkit-"))
        if (
            normalized not in blocked
            and (normalized in AGENT_REQUEST_HEADERS or allowed_extension)
            and len(value) <= 8192
        ):
            headers.append((name, value))
    return headers


def filter_response_headers(multi_items, connection_values):
    blocked = HOP_BY_HOP_HEADERS | connection_tokens(connection_values)
    result = []
    for name, value in multi_items:
        normalized = name.lower()
        if normalized not in blocked and normalized in AGENT_RESPONSE_HEADERS:
            result.append((name, value))
    return result


def path_kind(agent_path):
    normalized = (agent_path or "").strip("/")
    if not normalized:
        return "document"
    if normalized in {"health", "info"} or normalized.startswith("_next/"):
        return "asset"
    if normalized == "api/copilotkit" or normalized.startswith(
        "api/copilotkit/"
    ):
        return "runtime"
    return None


def request_is_unambiguous(raw_path):
    raw_path = raw_path.split("?", 1)[0]
    lowered = raw_path.lower()
    if raw_path.startswith(("http://", "https://")):
        return False
    if any(value in lowered for value in ("%2f", "%5c", "%00")):
        return False
    if "\\" in raw_path or "//" in raw_path:
        return False
    return all(part not in (".", "..") for part in raw_path.split("/"))


def safe_agent_location(current_url, location, origin):
    if not location or len(location) > 4096:
        return None
    resolved = urlsplit(urljoin(current_url, location))
    expected = urlsplit(origin)
    if (
        resolved.scheme != expected.scheme
        or resolved.hostname != expected.hostname
        or resolved.port != expected.port
        or resolved.username
        or resolved.password
        or resolved.fragment
        or not (
            resolved.path == "/agent"
            or resolved.path.startswith("/agent/")
        )
    ):
        return None
    return resolved.path + (f"?{resolved.query}" if resolved.query else "")
