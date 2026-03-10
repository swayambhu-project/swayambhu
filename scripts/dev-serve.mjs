#!/usr/bin/env node
// Zero-cache static file server for the dashboard SPA.
// Usage: node scripts/dev-serve.mjs [port]
//
// Sets Cache-Control: no-store on every response so code changes
// are picked up immediately without hard-refresh.

import { createServer } from "http";
import { createReadStream, existsSync, statSync } from "fs";
import { resolve, extname, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteDir = resolve(__dirname, "..", "site");
const port = parseInt(process.argv[2] || "3001", 10);

const MIME = {
  ".html": "text/html",
  ".js":   "text/javascript",
  ".mjs":  "text/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

createServer((req, res) => {
  // Proxy /wake to brainstem
  if (req.url === "/wake" && req.method === "POST") {
    import("http").then(({ default: http }) => {
      http.get("http://localhost:8787/__scheduled", (r) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: r.statusCode }));
      }).on("error", (e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    });
    return;
  }

  let urlPath = req.url.split("?")[0];

  // Serve index.html for directory paths
  if (urlPath.endsWith("/")) urlPath += "index.html";

  let file = join(siteDir, urlPath);

  // If path is a directory, redirect to add trailing slash or serve index.html
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, "index.html");
  }

  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const mime = MIME[extname(file)] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`Dashboard SPA: http://localhost:${port}/operator/`);
});
