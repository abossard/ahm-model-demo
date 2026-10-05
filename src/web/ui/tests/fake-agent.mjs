import { createServer } from "node:http";

const port = Number(process.env.AGENT_FAKE_PORT ?? "8100");

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/agent/_next/static/fake-agent.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      "document.documentElement.dataset.agentReady='true';" +
        "window.parent&&window.parent!==window&&window.parent.postMessage({type:'health-agent-ready',version:1},window.location.origin);" +
        "window.addEventListener('message',function(event){if(event.origin!==window.location.origin)return;" +
        "if(event.data&&event.data.type==='health-agent-theme'&&(event.data.theme==='light'||event.data.theme==='dark')){document.documentElement.dataset.theme=event.data.theme;}});" +
        "var input=document.querySelector('textarea');" +
        "if(input){input.addEventListener('keydown',async function(event){if(event.key!=='Enter'||event.shiftKey)return;event.preventDefault();" +
        "var payload={threadId:'fake-thread',runId:'fake-run',messages:[{id:'fake-user-1',role:'user',content:input.value}]};" +
        "try{var response=await fetch('/agent/api/copilotkit/agent/default/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});" +
        "if(response.ok)return;var body=null;try{body=await response.json();}catch(_unused){}" +
        "var error=body&&body.error&&typeof body.error==='object'?body.error:{};" +
        "var retryable=error.retryable!==false;" +
        "var operationId=typeof error.operationId==='string'?error.operationId:'op-fake';" +
        "var message=typeof error.message==='string'?error.message:(retryable?'The assistant is temporarily unavailable. Retry to reconnect.':'The assistant requires configuration before it can run.');" +
        "window.parent.postMessage({type:'health-agent-error',version:1,component:'agent-app',retryable:retryable,operationId:operationId,message:message},window.location.origin);" +
        "}catch(_unused){window.parent.postMessage({type:'health-agent-error',version:1,component:'agent-app',retryable:true,operationId:'op-fake-network',message:'The assistant is temporarily unavailable. Retry to reconnect.'},window.location.origin);}});}" +
        "document.addEventListener('keydown',function(event){if(event.key==='Escape'){window.parent.postMessage({type:'health-agent-close',version:1},window.location.origin);}},true);",
    );
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/agent")) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';",
      "Cache-Control": "no-store",
    });
    response.end(
      "<!doctype html><html><head><meta charset=\"utf-8\">" +
        "<title>Health copilot</title></head>" +
        "<body><main id=\"fake-root\">copilot ready</main>" +
        "<textarea aria-label=\"Fake copilot input\"></textarea>" +
      "<script src=\"/agent/_next/static/fake-agent.js\"></script></body></html>",
    );
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1");
