import importlib
import os
import sys
from types import SimpleNamespace
from unittest import mock

SUBSCRIPTION_ID = "b2af20ad-98fa-4aa7-94c3-059663641d9f"
env = {
    "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000001",
    "QUEUE_URL": "https://example.queue.core.windows.net/requests",
    "POSTGRES_HOST": "pg.example.postgres.database.azure.com",
    "POSTGRES_DATABASE": "demo",
    "POSTGRES_USER": "id-ahm-demo-app",
    "APPLICATIONINSIGHTS_CONNECTION_STRING": "InstrumentationKey=00000000-0000-0000-0000-000000000000",
    "AZURE_SUBSCRIPTION_ID": SUBSCRIPTION_ID,
    "AZURE_SUBSCRIPTION_NAME": "ME-MngEnvMCAP462928-anbossar-1",
    "AZURE_RESOURCE_GROUP": "rg-ahm-demo",
    "HEALTH_MODEL_NAME": "hm-ahm-demo",
    "HEALTH_MODEL_LOCATION": "northeurope",
}
mock.patch.dict(os.environ, env, clear=False).start()
mock.patch("azure.identity.ManagedIdentityCredential", return_value=mock.Mock()).start()
mock.patch("azure.storage.queue.QueueClient.from_queue_url", return_value=mock.Mock()).start()
mock.patch("azure.monitor.opentelemetry.configure_azure_monitor").start()
mock.patch("azure.mgmt.cloudhealth.CloudHealthMgmtClient", return_value=mock.Mock()).start()

sys.path.insert(0, os.path.abspath("src/web/app"))
main = importlib.import_module("main")
print("import OK")

from fastapi.testclient import TestClient

client = TestClient(main.app)
r = client.get("/")
print("GET / ->", r.status_code, r.headers.get("content-type"))
print("has /assets/ in body:", "/assets/" in r.text)
print("CSP:", r.headers.get("content-security-policy"))
print("Cache-Control:", r.headers.get("cache-control"))
print("XCTO:", r.headers.get("x-content-type-options"))

r2 = client.get("/?format=xml")
print("GET /?format=xml ->", r2.status_code, r2.json().get("error", {}).get("code"))

r3 = client.get("/entity/api")
print("deep link /entity/api ->", r3.status_code, "root" in r3.text)
