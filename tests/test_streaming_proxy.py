import os
import select
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path


class UvicornStreamingProxyTests(unittest.TestCase):
    def test_first_sse_chunk_arrives_before_upstream_completes(self):
        root = Path(__file__).parents[1]
        environment = {
            **os.environ,
            "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000001",
            "QUEUE_URL": "https://example.queue.core.windows.net/requests",
            "POSTGRES_HOST": "pg.example.postgres.database.azure.com",
            "POSTGRES_DATABASE": "demo",
            "POSTGRES_USER": "id-ahm-demo-app",
            "APPLICATIONINSIGHTS_CONNECTION_STRING": (
                "InstrumentationKey=00000000-0000-0000-0000-000000000000"
            ),
            "AZURE_SUBSCRIPTION_ID": "11111111-1111-1111-1111-111111111111",
            "AZURE_SUBSCRIPTION_NAME": "Example Subscription",
            "AZURE_RESOURCE_GROUP": "rg-ahm-demo",
            "HEALTH_MODEL_NAME": "hm-ahm-demo",
            "HEALTH_MODEL_LOCATION": "northeurope",
            "HEALTH_COPILOT_ENABLED": "true",
        }
        fake = subprocess.Popen(
            [sys.executable, str(root / "tests/fake_streaming_agent_web.py")],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        server = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "--app-dir",
                "src/web/app",
                "--host",
                "127.0.0.1",
                "--port",
                "8082",
                "main:app",
            ],
            cwd=root,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self._wait_for_port(3000)
            self._wait_for_port(8082)
            started = time.monotonic()
            with socket.create_connection(("127.0.0.1", 8082), timeout=2) as client:
                client.sendall(
                    b"GET /agent/api/copilotkit/default/run HTTP/1.1\r\n"
                    b"Host: 127.0.0.1:8082\r\n"
                    b"Accept: text/event-stream\r\n"
                    b"Connection: close\r\n\r\n"
                )
                received = b""
                first_elapsed = None
                finish_elapsed = None
                while finish_elapsed is None:
                    readable, _, _ = select.select([client], [], [], 5)
                    self.assertTrue(readable, "stream stalled")
                    chunk = client.recv(4096)
                    if not chunk:
                        break
                    received += chunk
                    elapsed = time.monotonic() - started
                    if first_elapsed is None and b"RUN_STARTED" in received:
                        first_elapsed = elapsed
                    if b"RUN_FINISHED" in received:
                        finish_elapsed = elapsed

            self.assertIsNotNone(first_elapsed)
            self.assertIsNotNone(finish_elapsed)
            self.assertLess(first_elapsed, finish_elapsed)
            self.assertGreaterEqual(finish_elapsed - first_elapsed, 0.45)
            self.assertLess(received.index(b"RUN_STARTED"), received.index(b"RUN_FINISHED"))
        finally:
            self._stop(server)
            self._stop(fake)

    @staticmethod
    def _wait_for_port(port):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.05)
        raise AssertionError(f"port {port} did not become ready")

    @staticmethod
    def _stop(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()


if __name__ == "__main__":
    unittest.main()
