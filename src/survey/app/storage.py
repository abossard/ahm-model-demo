import base64
import hashlib
import re
import secrets
import string
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

from .model import SCALE, SurveyError, canonical_code, check_edit, stale


def verifier(header, purpose):
    if not header or not re.fullmatch(r"Bearer [A-Za-z0-9_-]{43}", header):
        raise SurveyError(403, "invalid_capability", "A valid private capability is required.")
    token = header[7:]
    raw = base64.urlsafe_b64decode(token + "=")
    if base64.urlsafe_b64encode(raw).decode().rstrip("=") != token:
        raise SurveyError(403, "invalid_capability", "A valid private capability is required.")
    return hashlib.sha256(purpose.encode() + b":" + raw).hexdigest()


class Storage:
    def __init__(self, connect):
        self.connect = connect

    def new_code(self):
        return "".join(secrets.choice(string.ascii_uppercase) for _ in range(6))

    def _survey(self, conn, code, lock=False):
        row = conn.execute(
            "SELECT * FROM survey.surveys WHERE code=%s" + (" FOR UPDATE" if lock else ""),
            (canonical_code(code),),
        ).fetchone()
        if row is None:
            raise SurveyError(404, "not_found", "Survey not found. Check the code.")
        return row

    def _definition(self, conn, row):
        questions = conn.execute(
            "SELECT id, statement FROM survey.questions WHERE survey_id=%s ORDER BY position",
            (row["id"],),
        ).fetchall()
        return {
            "code": row["code"], "version": row["version"],
            "scale": dict(SCALE), "voting_started": row["voting_started_at"] is not None,
            "questions": [{"id": str(q["id"]), "statement": q["statement"]} for q in questions],
        }

    def create(self, definition, authorization):
        key = verifier(authorization, "author")
        with self.connect() as conn:
            conn.row_factory = dict_row
            # Serialize capability retries even before a survey row exists.
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (int(key[:15], 16),))
            row = conn.execute(
                "SELECT * FROM survey.surveys WHERE author_verifier=%s", (key,),
            ).fetchone()
            if row:
                return self._definition(conn, row)
            for _ in range(10):
                try:
                    with conn.transaction():
                        row = conn.execute(
                            "INSERT INTO survey.surveys (id,code,author_verifier) VALUES (%s,%s,%s) RETURNING *",
                            (uuid4(), self.new_code(), key),
                        ).fetchone()
                    break
                except psycopg.errors.UniqueViolation as error:
                    if error.diag.constraint_name != "surveys_code_key":
                        raise
            else:
                raise SurveyError(503, "code_unavailable", "Cannot allocate a survey code. Retry with the same private key.")
            self._questions(conn, row["id"], definition.questions)
            return self._definition(conn, row)

    def _questions(self, conn, survey_id, questions):
        for position, question in enumerate(questions):
            conn.execute(
                """INSERT INTO survey.questions (survey_id,id,position,statement)
                   VALUES (%s,%s,%s,%s)
                   ON CONFLICT (survey_id,id) DO UPDATE
                   SET position=EXCLUDED.position, statement=EXCLUDED.statement""",
                (survey_id, question.id, position, question.statement),
            )

    def read(self, code, authorization=None, editor=False):
        key = verifier(authorization, "author") if editor else None
        with self.connect() as conn:
            conn.row_factory = dict_row
            row = self._survey(conn, code, lock=True)
            if editor and row["author_verifier"] != key:
                raise SurveyError(403, "invalid_capability", "The private editing key is not valid for this survey.")
            return self._definition(conn, row)

    def edit(self, code, definition, authorization):
        key = verifier(authorization, "author")
        with self.connect() as conn:
            conn.row_factory = dict_row
            row = self._survey(conn, code, lock=True)
            if row["author_verifier"] != key:
                raise SurveyError(403, "invalid_capability", "The private editing key is not valid for this survey.")
            if row["version"] != definition.version:
                raise stale()
            check_edit(self._definition(conn, row)["questions"], definition.questions,
                       row["voting_started_at"] is not None)
            self._questions(conn, row["id"], definition.questions)
            row = conn.execute(
                "UPDATE survey.surveys SET version=version+1 WHERE id=%s RETURNING *",
                (row["id"],),
            ).fetchone()
            return self._definition(conn, row)

    def _ballot(self, conn, survey_id, key):
        row = conn.execute(
            "SELECT id,version FROM survey.ballots WHERE survey_id=%s AND response_verifier=%s",
            (survey_id, key),
        ).fetchone()
        if row is None:
            return {"version": 0, "answers": {}}
        answers = conn.execute(
            "SELECT question_id,value FROM survey.answers WHERE survey_id=%s AND ballot_id=%s",
            (survey_id, row["id"]),
        ).fetchall()
        return {"version": row["version"],
                "answers": {str(a["question_id"]): a["value"] for a in answers}}

    def ballot(self, code, authorization):
        key = verifier(authorization, "response")
        with self.connect() as conn:
            conn.row_factory = dict_row
            row = self._survey(conn, code, lock=True)
            return self._ballot(conn, row["id"], key)

    def save(self, code, patch, authorization):
        key = verifier(authorization, "response")
        with self.connect() as conn:
            conn.row_factory = dict_row
            row = self._survey(conn, code, lock=True)
            if row["version"] != patch.survey_version:
                raise stale()
            ids = {q["id"] for q in conn.execute(
                "SELECT id FROM survey.questions WHERE survey_id=%s", (row["id"],),
            ).fetchall()}
            if not patch.answers.keys() <= ids:
                raise SurveyError(422, "invalid_question", "An answer refers to a question outside this survey.")
            ballot = conn.execute(
                "SELECT * FROM survey.ballots WHERE survey_id=%s AND response_verifier=%s FOR UPDATE",
                (row["id"], key),
            ).fetchone()
            if (ballot["version"] if ballot else 0) != patch.version:
                raise stale()
            if ballot is None:
                ballot = conn.execute(
                    "INSERT INTO survey.ballots (survey_id,id,response_verifier) VALUES (%s,%s,%s) RETURNING *",
                    (row["id"], uuid4(), key),
                ).fetchone()
            for question, value in patch.answers.items():
                if value is None:
                    conn.execute(
                        "DELETE FROM survey.answers WHERE survey_id=%s AND ballot_id=%s AND question_id=%s",
                        (row["id"], ballot["id"], question),
                    )
                else:
                    conn.execute(
                        """INSERT INTO survey.answers (survey_id,ballot_id,question_id,value)
                           VALUES (%s,%s,%s,%s) ON CONFLICT (survey_id,ballot_id,question_id)
                           DO UPDATE SET value=EXCLUDED.value""",
                        (row["id"], ballot["id"], question, value),
                    )
            if any(v is not None for v in patch.answers.values()):
                conn.execute(
                    "UPDATE survey.surveys SET voting_started_at=COALESCE(voting_started_at,now()) WHERE id=%s",
                    (row["id"],),
                )
            conn.execute(
                "UPDATE survey.ballots SET version=version+1 WHERE survey_id=%s AND id=%s",
                (row["id"], ballot["id"]),
            )
            return self._ballot(conn, row["id"], key)

    def results(self, code):
        with self.connect() as conn:
            conn.row_factory = dict_row
            row = self._survey(conn, code, lock=True)
            definition = self._definition(conn, row)
            counts = conn.execute(
                """SELECT question_id,value,count(*) AS count FROM survey.answers
                   WHERE survey_id=%s GROUP BY question_id,value""", (row["id"],),
            ).fetchall()
            for question in definition["questions"]:
                distribution = [0] * (SCALE["max"] + 1)
                for bucket in counts:
                    if str(bucket["question_id"]) == question["id"]:
                        distribution[bucket["value"]] = bucket["count"]
                count = sum(distribution)
                question.update(
                    count=count, distribution=distribution,
                    mean=sum(v * n for v, n in enumerate(distribution)) / count if count else None,
                )
            return definition

    def ready(self):
        with self.connect() as conn:
            conn.execute("SELECT 1")
            versions = conn.execute("SELECT version FROM survey.schema_migrations ORDER BY version").fetchall()
            if versions != [(1,)]:
                raise SurveyError(503, "schema_unavailable", "Survey schema migration is required.")
