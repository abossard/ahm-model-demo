import importlib
import os
import sys
import time
from unittest import mock

import httpx

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
    "HEALTH_COPILOT_ENABLED": "true",
}
mock.patch.dict(os.environ, env, clear=False).start()
mock.patch("azure.identity.ManagedIdentityCredential", return_value=mock.Mock()).start()
mock.patch("azure.storage.queue.QueueClient.from_queue_url", return_value=mock.Mock()).start()
mock.patch("azure.monitor.opentelemetry.configure_azure_monitor").start()
mock.patch("azure.mgmt.cloudhealth.CloudHealthMgmtClient", return_value=mock.Mock()).start()

sys.path.insert(0, os.path.abspath("src/web/app"))
main = importlib.import_module("main")
from fastapi.testclient import TestClient

client = TestClient(main.app)

# 1) header preservation + stripping
seen = []
def upstream(request):
    body = request.read()
    seen.append((request, body))
    return httpx.Response(202, headers={
        "Content-Type": "application/json", "Content-Encoding": "identity",
        "Cache-Control": "no-cache", "Connection": "x-internal",
        "X-Internal": "do-not-forward", "Set-Cookie": "session=secret",
        "Content-Length": "999",
    }, stream=httpx.ByteStream(b'{"status":"accepted"}'))
hc = httpx.Client(transport=httpx.MockTransport(upstream))
with mock.patch.object(main, "_agent_client_factory", return_value=hc):
    r = client.post("/agent/api/copilotkit/default/run?thread=one&thread=two",
        content=b'{"message":"hello"}',
        headers={"content-type": "application/json", "Cookie": "caller=secret",
                 "X-Forwarded-Host": "evil.example", "Connection": "x-caller",
                 "X-Caller": "do-not-forward"})
print("proxy status", r.status_code, "body", r.content)
print("CT", r.headers.get("Content-Type"), "CE", r.headers.get("Content-Encoding"), "CC", r.headers.get("Cache-Control"))
print("stripped:", [n for n in ("Connection","X-Internal","Set-Cookie","Content-Length") if n in r.headers])
req, body = seen[0]
print("up path", req.url.path, "params", list(req.url.params.multi_items()), "host", req.headers.get("host"))
print("up stripped", [n for n in ("cookie","x-forwarded-host","x-caller") if n in req.headers])

# 2) streaming incremental + closed
class DelayedStream(httpx.SyncByteStream):
    def __init__(self): self.closed = False
    def __iter__(self):
        yield b"event: start\ndata: one\n\n"
        time.sleep(0.08)
        yield b"event: finish\ndata: two\n\n"
    def close(self): self.closed = True
stream = DelayedStream()
hc2 = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(200,
    headers={"Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache"}, stream=stream)))
with mock.patch.object(main, "_agent_client_factory", return_value=hc2):
    started = time.monotonic()
    with client.stream("GET", "/agent/api/copilotkit/default/run") as resp:
        it = resp.iter_raw()
        first = next(it)
        first_elapsed = time.monotonic() - started
        rest = b"".join(it)
print("stream first_elapsed", round(first_elapsed, 4), "first", first)
print("stream full", first + rest)
print("stream closed", stream.closed)

# 3) disconnect closes upstream
class OpenStream(httpx.SyncByteStream):
    def __init__(self): self.closed = False
    def __iter__(self):
        yield b"event: RUN_STARTED\ndata: one\n\n"
        yield b"event: TEXT_MESSAGE_CONTENT\ndata: two\n\n"
    def close(self): self.closed = True
ostream = OpenStream()
hc3 = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(200,
    headers={"Content-Type": "text/event-stream"}, stream=ostream)))
with mock.patch.object(main, "_agent_client_factory", return_value=hc3):
    with client.stream("GET", "/agent/api/copilotkit/default/run") as resp:
        it = resp.iter_raw()
        chunk = next(it)
        print("disc first", b"RUN_STARTED" in chunk)
print("disconnect closed", ostream.closed)
