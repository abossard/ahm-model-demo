from config import (
    CANONICAL_SIGNAL_NAME,
    HEALTH_STATES,
    REASON_PRESETS,
    REPORT_EXPIRIES,
    REPORT_KEYS,
    REPORT_VALUES,
)


def validate_report_body(body):
    if not isinstance(body, dict):
        return "invalid_json", "The request body must be a JSON object."
    unknown = set(body) - REPORT_KEYS
    if unknown:
        return "unknown_field", "The request contains an unsupported field."
    required = {
        "signalName",
        "healthState",
        "value",
        "expiresInMinutes",
        "reasonPreset",
    }
    if not required.issubset(body):
        return "missing_field", "All visible report fields are required."
    if body["signalName"] != CANONICAL_SIGNAL_NAME:
        return "invalid_signal", "Only the displayed report signal is supported."
    if body["healthState"] not in HEALTH_STATES:
        return "invalid_state", "Select a supported health state."
    value = body["value"]
    if isinstance(value, bool) or value not in REPORT_VALUES:
        return "invalid_value", "Select a supported report value."
    expiry = body["expiresInMinutes"]
    if isinstance(expiry, bool) or expiry not in REPORT_EXPIRIES:
        return "invalid_expiry", "Select a supported expiry."
    preset = body["reasonPreset"]
    if preset not in REASON_PRESETS:
        return "invalid_reason", "Select a supported reason."
    custom_reason = body.get("customReason")
    if preset == "custom":
        if (
            not isinstance(custom_reason, str)
            or not custom_reason.strip()
            or len(custom_reason.strip()) > 280
            or "\x00" in custom_reason
        ):
            return "invalid_reason", "Enter a custom reason of 1 to 280 characters."
    elif custom_reason is not None:
        return "invalid_reason", "Custom reason is available only with Custom."
    return None
