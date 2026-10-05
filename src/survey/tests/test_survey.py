import base64
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import secrets
import subprocess
import unittest
from unittest import mock
from uuid import uuid4

import psycopg
from fastapi.testclient import TestClient

from src.survey.app.main import create_app
from src.survey.app.storage import Storage


ROOT = Path(__file__).resolve().parents[1]
DSN = os.environ.get("SURVEY_TEST_DSN")


def capability():
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")


@unittest.skipUnless(DSN, "requires explicit disposable SURVEY_TEST_DSN")
class SurveyHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if psycopg.conninfo.conninfo_to_dict(DSN).get("host") != "127.0.0.1":
            raise RuntimeError("HTTP database proof accepts only a disposable loopback database")
        subprocess.run(
            ["psql", DSN, "-X", "-v", "ON_ERROR_STOP=1", "-v",
             "uami_name=survey_test", "-f", str(ROOT / "migrations/001_initial.sql")],
            check=True, capture_output=True,
        )

    def setUp(self):
        self.storage = Storage(lambda: psycopg.connect(DSN))
        self.client = TestClient(create_app(self.storage))
        self.author = capability()
        self.headers = {"Authorization": f"Bearer {self.author}"}
        self.questions = [
            {"id": str(uuid4()), "statement": "<script>First statement</script>"},
            {"id": str(uuid4()), "statement": "Second statement"},
        ]
        response = self.client.post("/api/surveys", headers=self.headers,
                                    json={"questions": self.questions})
        self.assertEqual(response.status_code, 201, response.text)
        self.survey = response.json()
        self.code = self.survey["code"]
        self.url = f"/api/surveys/{self.code}"
        self.response_headers = {"Authorization": f"Bearer {capability()}"}

    def save(self, answers, version=0, survey_version=1, headers=None):
        return self.client.put(
            self.url + "/ballot", headers=headers or self.response_headers,
            json={"version": version, "survey_version": survey_version, "answers": answers},
        )

    def test_create_retry_and_unique_code(self):
        self.assertRegex(self.code, r"^[A-Z]{6}$")
        again = self.client.post("/api/surveys", headers=self.headers,
                                 json={"questions": self.questions})
        self.assertEqual(again.json(), self.survey)
        with psycopg.connect(DSN) as conn:
            verifier = conn.execute(
                "SELECT author_verifier FROM survey.surveys WHERE code=%s", (self.code,)
            ).fetchone()[0]
        self.assertNotIn(self.author, str(verifier))
        self.assertEqual(len(verifier), 64)
        fresh = self.storage.new_code()
        with mock.patch.object(self.storage, "new_code", side_effect=[self.code, fresh]):
            result = self.client.post("/api/surveys",
                                      headers={"Authorization": f"Bearer {capability()}"},
                                      json={"questions": self.questions})
        self.assertEqual(result.status_code, 201, result.text)
        with mock.patch.object(self.storage, "new_code", return_value=self.code):
            failed = self.client.post("/api/surveys",
                                      headers={"Authorization": f"Bearer {capability()}"},
                                      json={"questions": self.questions})
        self.assertEqual(failed.status_code, 503)

    def test_invalid_payloads_and_capabilities(self):
        for value in (-1, 101, True, "50", 1.5):
            with self.subTest(value=value):
                self.assertEqual(self.save({self.questions[0]["id"]: value}).status_code, 422)
        for headers in ({}, {"Authorization": "Bearer bad"},
                        {"Authorization": f"Bearer {capability()}"}):
            with self.subTest(headers=bool(headers)):
                result = self.client.put(self.url, headers=headers,
                                         json={"version": 1, "questions": self.questions})
                self.assertEqual(result.status_code, 403)
        for code, expected in (("123456", 400), ("TOOLONG", 400), ("Q", 400),
                               ("@@@@@@", 400), ("ZZZZZY", 404)):
            with self.subTest(code=code):
                self.assertEqual(self.client.get(f"/api/surveys/{code}").status_code, expected)
        self.assertEqual(self.client.get(self.url.lower()).status_code, 200)
        blank = self.client.post("/api/surveys", headers=self.headers,
                                 json={"questions": [{"id": str(uuid4()), "statement": " "}]})
        self.assertEqual(blank.status_code, 422)
        self.assertEqual(self.client.get(self.url).json(), self.survey)
        for code, expected in (("123456", 400), ("ZZZZZY", 404)):
            with self.subTest(results_code=code):
                self.assertEqual(self.client.get(f"/api/surveys/{code}/results").status_code, expected)
        for value in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(nonfinite=value):
                response = self.client.put(
                    self.url + "/ballot", headers={**self.response_headers, "Content-Type": "application/json"},
                    content='{"version":0,"survey_version":1,"answers":{"' + self.questions[0]["id"] + '":' + value + '}}',
                )
                self.assertEqual(response.status_code, 422)

    def test_partial_midpoint_reset_and_permanent_wording_lock(self):
        first, second = (q["id"] for q in self.questions)
        self.assertEqual(self.client.get(self.url + "/results").json()["questions"][0]["mean"], None)
        self.assertEqual(self.save({first: 50, second: 100}).status_code, 200)
        ballot = self.client.get(self.url + "/ballot", headers=self.response_headers).json()
        self.assertEqual(ballot["answers"], {first: 50, second: 100})
        other = self.client.get(self.url + "/ballot",
                                headers={"Authorization": f"Bearer {capability()}"}).json()
        self.assertEqual(other["answers"], {})
        self.assertEqual(self.save({first: None}, version=1).status_code, 200)
        results = self.client.get(self.url + "/results").json()["questions"]
        self.assertEqual([(q["count"], q["mean"]) for q in results], [(0, None), (1, 100)])
        self.assertEqual(self.save({second: None}, version=2).status_code, 200)
        changed = [dict(q) for q in self.questions]
        changed[1]["statement"] = "Changed unanswered question"
        locked = self.client.put(self.url, headers=self.headers,
                                  json={"version": 1, "questions": changed})
        self.assertEqual(locked.status_code, 409)
        added = {"id": str(uuid4()), "statement": "Added after voting"}
        saved = self.client.put(self.url, headers=self.headers,
                                 json={"version": 1, "questions": [added, *reversed(self.questions)]})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["questions"][1]["id"], second)
        self.assertTrue(saved.json()["voting_started"])
        self.assertEqual(self.save({first: 0}, version=3).status_code, 409)
        self.assertEqual(self.save({str(uuid4()): 0}, version=3, survey_version=2).status_code, 422)

    def test_concurrent_initial_saves_and_lost_reply_recovery(self):
        first = self.questions[0]["id"]
        with ThreadPoolExecutor(max_workers=2) as workers:
            responses = list(workers.map(lambda value: self.save({first: value}), [0, 100]))
        self.assertEqual(sorted(r.status_code for r in responses), [200, 409])
        recovered = self.client.get(self.url + "/ballot", headers=self.response_headers).json()
        self.assertEqual(recovered["version"], 1)
        self.assertEqual(self.client.get(self.url + "/results").json()["questions"][0]["count"], 1)
        self.assertEqual(self.save({first: 50}, version=recovered["version"]).status_code, 200)
        self.assertEqual(self.save({first: None}, version=1).status_code, 409)

    def test_invalid_private_ballot_read_and_other_survey_ids_never_write(self):
        self.assertEqual(self.client.get(self.url + "/ballot").status_code, 403)
        self.assertEqual(self.client.get(self.url + "/ballot",
                                        headers={"Authorization": "Bearer bad"}).status_code, 403)
        before = self.client.get(self.url + "/results").json()
        self.assertEqual(self.save({str(uuid4()): 50}).status_code, 422)
        self.assertEqual(self.client.get(self.url + "/results").json(), before)
        with psycopg.connect(DSN) as conn:
            self.assertEqual(conn.execute(
                "SELECT count(*) FROM survey.ballots b JOIN survey.surveys s ON s.id=b.survey_id WHERE s.code=%s",
                (self.code,),
            ).fetchone()[0], 0)

    def test_other_uniqueness_errors_are_not_join_code_retries(self):
        from psycopg import errors
        fake = mock.MagicMock()
        fake.__enter__.return_value = fake
        fake.execute.side_effect = [mock.Mock(), mock.Mock(fetchone=lambda: None), errors.UniqueViolation()]
        store = Storage(lambda: fake)
        with mock.patch.object(store, "new_code", return_value="ABCDEF") as entropy:
            with self.assertRaises(errors.UniqueViolation):
                from src.survey.app.model import Definition
                store.create(Definition(questions=self.questions), self.headers["Authorization"])
        entropy.assert_called_once()

    def test_public_aggregates_have_no_identity(self):
        first, second = (q["id"] for q in self.questions)
        self.save({first: 0, second: 50})
        self.save({first: 100}, headers={"Authorization": f"Bearer {capability()}"})
        result = self.client.get(self.url + "/results").json()
        self.assertEqual([(q["count"], q["mean"]) for q in result["questions"]], [(2, 50), (1, 50)])
        self.assertEqual(sum(result["questions"][0]["distribution"]), 2)
        self.assertNotIn("verifier", str(result))
        self.assertNotIn(self.author, str(result))

    def test_first_vote_races_author_edit(self):
        first = self.questions[0]["id"]
        changed = [dict(q) for q in self.questions]
        changed[0]["statement"] = "New wording"
        with ThreadPoolExecutor(max_workers=2) as workers:
            vote = workers.submit(self.save, {first: 75})
            edit = workers.submit(self.client.put, self.url, headers=self.headers,
                                  json={"version": 1, "questions": changed})
            statuses = (vote.result().status_code, edit.result().status_code)
        self.assertIn(statuses, ((200, 409), (409, 200)))


if __name__ == "__main__":
    unittest.main()
