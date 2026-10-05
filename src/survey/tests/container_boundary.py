from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gzip
import json
import os
import ssl
import time


class Boundary(BaseHTTPRequestHandler):
    resource_count = 0
    request_names = set()

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/observations":
            body = json.dumps({"resource_count": Boundary.resource_count,
                               "request_names": sorted(Boundary.request_names)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = json.dumps({
            "access_token": "local-disposable-identity-token",
            "expires_on": str(int(time.time()) + 3600),
            "resource": "https://ossrdbms-aad.database.windows.net",
            "token_type": "Bearer",
            "client_id": "00000000-0000-0000-0000-000000000001",
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        envelopes = json.loads(body)
        if isinstance(envelopes, dict):
            envelopes = [envelopes]
        for envelope in envelopes:
            data = envelope.get("data", {})
            if data.get("baseType") == "RequestData":
                Boundary.request_names.add(data["baseData"]["name"])
            if data.get("baseType") == "MetricData" and any(
                    metric.get("name") == "_OTELRESOURCE_" for metric in data["baseData"]["metrics"]):
                Boundary.resource_count += 1
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"itemsReceived":1,"itemsAccepted":1,"errors":[]}')


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 4188), Boundary)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(os.environ["SURVEY_BOUNDARY_CERT"], os.environ["SURVEY_BOUNDARY_KEY"])
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
