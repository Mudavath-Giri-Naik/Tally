/**
 * Local development shim.
 *
 * supabase-js addresses PostgREST under /rest/v1; a bare PostgREST serves at
 * the root. This strips the prefix so the real Supabase client can talk to a
 * plain Postgres + PostgREST pair locally, without a Supabase project.
 *
 * Not used in production - there, SUPABASE_URL points at Supabase itself.
 *
 *   node scripts/postgrest-proxy.mjs [listenPort] [postgrestPort]
 */
import { createServer, request } from "node:http";

const listenPort = Number(process.argv[2] ?? 54340);
const upstreamPort = Number(process.argv[3] ?? 54331);

createServer((req, res) => {
  const path = (req.url ?? "/").replace(/^\/rest\/v1/, "");
  const upstream = request(
    {
      host: "127.0.0.1",
      port: upstreamPort,
      path,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 500, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  });
  req.pipe(upstream);
}).listen(listenPort, "127.0.0.1", () => {
  console.log(
    `postgrest proxy: http://127.0.0.1:${listenPort}/rest/v1 -> http://127.0.0.1:${upstreamPort}`,
  );
});
