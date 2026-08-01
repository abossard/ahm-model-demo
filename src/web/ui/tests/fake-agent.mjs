import { createServer } from "node:http";

const port = Number(process.env.AGENT_FAKE_PORT ?? "8100");

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname.startsWith("/agent")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><meta charset=\"utf-8\">" +
        "<title>Health copilot</title></head>" +
        "<body><main>copilot ready</main></body></html>",
    );
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1");
