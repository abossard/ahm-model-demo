import re
from collections.abc import Iterable

MIN_SECRET_LENGTH = 8
REDACTED = "[redacted]"
SECRET_SHAPES = re.compile(
    r"eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*"
    r"|\bBearer\s+[\w.~+/=-]{16,}"
    r"|\b(?:InstrumentationKey|AccountKey|SharedAccessKey|SharedAccessSignature|Password|sig)=[^;&\s\"']+",
    re.IGNORECASE,
)


def redact(text: str, secrets: Iterable[str] = ()) -> str:
    """Text reaches the model, the public timeline and the log: drop the Task's own secrets and token shapes."""
    for secret in secrets:
        if len(secret) >= MIN_SECRET_LENGTH:
            text = text.replace(secret, REDACTED)
    return SECRET_SHAPES.sub(REDACTED, text)
