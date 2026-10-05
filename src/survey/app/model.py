import re
from types import MappingProxyType
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator


SCALE = MappingProxyType({"min": 0, "max": 100, "step": 1})


class SurveyError(Exception):
    def __init__(self, status, code, message):
        self.status = status
        self.code = code
        self.message = message
        super().__init__(message)


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    statement: str = Field(strict=True, min_length=1, max_length=2000)

    @field_validator("statement")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Statement must not be blank")
        return value.strip()


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    questions: list[Question] = Field(min_length=1, max_length=100)

    @field_validator("questions")
    @classmethod
    def unique_ids(cls, value):
        if len({q.id for q in value}) != len(value):
            raise ValueError("Question IDs must be unique")
        return value


class Edit(Definition):
    version: StrictInt = Field(ge=1)


class BallotPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: StrictInt = Field(ge=0)
    survey_version: StrictInt = Field(ge=1)
    answers: dict[UUID, StrictInt | None]

    @field_validator("answers")
    @classmethod
    def scale(cls, value):
        if len(value) > 100 or any(v is not None and not SCALE["min"] <= v <= SCALE["max"] for v in value.values()):
            raise ValueError("Answers must be integers from 0 to 100 or null")
        return value


def canonical_code(value):
    if not re.fullmatch("[A-Za-z]{6}", value):
        raise SurveyError(400, "invalid_code", "Enter a six-letter survey code.")
    return value.upper()


def check_edit(current, proposed, voting_started):
    existing = {q["id"]: q["statement"] for q in current}
    incoming = {str(q.id): q.statement for q in proposed}
    if not existing.keys() <= incoming.keys():
        raise SurveyError(409, "questions_required", "Existing questions cannot be removed.")
    if voting_started and any(incoming[key] != text for key, text in existing.items()):
        raise SurveyError(409, "wording_locked", "Voting has started. Add or reorder questions; existing wording is locked.")


def stale():
    return SurveyError(409, "stale_version", "Reload the current version, retain your edits, then retry.")
