// A minimal HTTP server that takes a while to become usable, then serves and
// logs every request. Used to measure time-to-usable and later-turn reachability.
//
// Usage: node dev-server.mjs <port> <startupMs>
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const startupMs = Number(process.argv[3] ?? 1200);

setTimeout(() => {
  const server = createServer((request, response) => {
    console.log(`served ${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`READY ${port}`);
  });
}, startupMs);
