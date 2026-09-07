/** Production browser gateway. No Vite, credentials in HTML, LAN binding or arbitrary file serving. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export function createDesktopGateway(opts: { dist: string; apiPort: number; token: string }): http.Server {
  const root = fs.realpathSync(opts.dist);
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
  const server = http.createServer((req, res) => {
    const reply = (code: number, error: string) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error }));
    };
    const address = server.address();
    const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    // Host blocks DNS rebinding; exact Origin (including port) blocks other local web apps.
    if (req.headers.host !== host || (origin !== undefined && origin !== `http://${host}`)
      || (site !== undefined && site !== "same-origin" && site !== "none")) {
      reply(403, "forbidden_origin"); return;
    }
    let pathname: string;
    try { pathname = decodeURIComponent((req.url ?? "/").split("?")[0]!); }
    catch { reply(400, "bad_path"); return; }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(p => p === ".." || p === ".")) {
      reply(400, "bad_path"); return;
    }
    if (pathname.startsWith("/api/")) {
      // Never accept proxy destinations or authentication supplied by the browser.
      const headers = { ...req.headers, host: `127.0.0.1:${opts.apiPort}`, authorization: `Bearer ${opts.token}` };
      delete headers.cookie;
      const upstream = http.request({ hostname: "127.0.0.1", port: opts.apiPort,
        path: (req.url ?? "").slice(4), method: req.method, headers }, incoming => {
        res.writeHead(incoming.statusCode ?? 502, { ...incoming.headers, "Cache-Control": "no-store" });
        incoming.on("error", () => res.destroy());
        incoming.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) reply(502, "api_unreachable"); else res.destroy(); });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { reply(405, "method_not_allowed"); return; }
    // SPA fallback only for extensionless navigation, never for missing assets or hidden files.
    if (pathname.split("/").some(p => p.startsWith("."))) { reply(404, "not_found"); return; }
    let target = path.join(root, pathname);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      if (path.extname(pathname)) { reply(404, "not_found"); return; }
      target = path.join(root, "index.html");
    }
    try {
      const real = fs.realpathSync(target);
      if (!real.startsWith(root + path.sep)) { reply(404, "not_found"); return; }
      const content = fs.readFileSync(real);
      res.writeHead(200, { "Content-Type": mime[path.extname(real)] ?? "application/octet-stream",
        "Content-Length": content.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch { reply(404, "not_found"); }
  });
  return server;
}
