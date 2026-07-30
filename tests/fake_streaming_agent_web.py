import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/agent/health":
            body = b'{"status":"ok","component":"health-copilot-web"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/agent/api/copilotkit/"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"event: RUN_STARTED\ndata: one\n\n")
            self.wfile.flush()
            time.sleep(0.5)
            self.wfile.write(b"event: RUN_FINISHED\ndata: two\n\n")
            self.wfile.flush()
            self.close_connection = True
            return
        self.send_error(404)

    def log_message(self, _format, *_args):
        return


ThreadingHTTPServer(("127.0.0.1", 3000), Handler).serve_forever()
