import json
import os
import secrets
import ssl
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


BASE = os.environ.get("SURVEY_CONTAINER_BASE_URL")


@unittest.skipUnless(BASE, "requires actual production image SURVEY_CONTAINER_BASE_URL")
class ProductionContainerHttpTests(unittest.TestCase):
    def call(self, path, method="GET", key=None, body=None):
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        request = Request(BASE + path, method=method, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urlopen(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            content = response.read().decode()
            return response.status, response.headers, content

    def test_production_image_serves_ui_and_persists_midpoint_reset_through_public_http(self):
        status, _, body = self.call("/api/ready")
        self.assertEqual(status, 200, "Production image readiness failed")
        self.assertEqual(json.loads(body), {"ready": True})
        for path in ("/", "/create", "/edit/ABCDEF", "/join/ABCDEF", "/results/ABCDEF"):
            with self.subTest(path=path):
                status, headers, content = self.call(path)
                self.assertEqual(status, 200)
                self.assertIn('id="root"', content)
                self.assertEqual(headers["Cache-Control"], "no-store")
        author = secrets.token_urlsafe(32)
        question = str(uuid4())
        status, _, body = self.call("/api/surveys", "POST", author, {
            "questions": [{"id": question, "statement": "Production entrypoint statement"}],
        })
        self.assertEqual(status, 201)
        survey = json.loads(body)
        code = survey["code"]
        status, _, public = self.call(f"/api/surveys/{code}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(public)["questions"], [{"id": question, "statement": "Production entrypoint statement"}])
        self.assertNotIn(author, public)
        response_key = secrets.token_urlsafe(32)
        status, _, body = self.call(f"/api/surveys/{code}/ballot", "PUT", response_key, {
            "version": 0, "survey_version": 1, "answers": {question: 50},
        })
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["answers"], {question: 50})
        status, _, body = self.call(f"/api/surveys/{code}/results")
        self.assertEqual(status, 200)
        self.assertEqual((json.loads(body)["questions"][0]["count"],
                          json.loads(body)["questions"][0]["mean"]), (1, 50))
        status, _, body = self.call(f"/api/surveys/{code}/ballot", "PUT", response_key, {
            "version": 1, "survey_version": 1, "answers": {question: None},
        })
        self.assertEqual(status, 200)
        status, _, body = self.call(f"/api/surveys/{code}/results")
        self.assertEqual(status, 200)
        self.assertEqual((json.loads(body)["questions"][0]["count"],
                          json.loads(body)["questions"][0]["mean"]), (0, None))
        self.assertEqual(self.call(f"/api/surveys/{code}/editor")[0], 403)
        self.assertEqual(self.call("/api/surveys/123456")[0], 400)

    @unittest.skipUnless(os.environ.get("SURVEY_BOUNDARY_CERT"), "requires external HTTPS ingestion fixture")
    def test_readiness_exports_operation_and_service_resource_metadata(self):
        self.assertEqual(self.call("/api/ready")[0], 200)
        context = ssl.create_default_context(cafile=os.environ["SURVEY_BOUNDARY_CERT"])
        deadline = time.monotonic() + 12
        observed = {}
        while time.monotonic() < deadline:
            with urlopen("https://localhost:4188/observations", context=context, timeout=5) as response:
                observed = json.load(response)
            if observed.get("resource_count", 0) > 0 and "readiness" in observed.get("request_names", []):
                break
            time.sleep(.25)
        self.assertIn("readiness", observed.get("request_names", []))
        self.assertGreater(observed.get("resource_count", 0), 0)
