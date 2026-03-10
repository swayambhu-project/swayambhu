// Swayambhu Dashboard API — stateless KV reader for operator dashboard

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Operator-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function auth(request, env) {
  const key = request.headers.get("X-Operator-Key");
  console.log("auth debug:", JSON.stringify({ header: key, env: env.OPERATOR_KEY, match: key === env.OPERATOR_KEY }));
  return key && key === env.OPERATOR_KEY;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — no auth
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /reflections — public, no auth required
    if (path === "/reflections") {
      const result = await env.KV.list({ prefix: "reflect:1:" });
      const keys = result.keys
        .filter(k => !k.name.startsWith("reflect:1:schedule"))
        .sort((a, b) => b.name.localeCompare(a.name));
      const reflections = await Promise.all(
        keys.slice(0, 20).map(async (k) => {
          const data = await env.KV.get(k.name, "json");
          if (!data) return null;
          return {
            session_id: data.session_id,
            timestamp: data.timestamp,
            reflection: data.reflection,
            note_to_future_self: data.note_to_future_self,
          };
        })
      );
      return json({ reflections: reflections.filter(Boolean) });
    }

    // All other routes require auth
    if (!auth(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    // POST /wake — trigger brainstem wake cycle
    if (path === "/wake" && request.method === "POST") {
      const brainstemUrl = env.BRAINSTEM_URL || "http://localhost:8787";
      try {
        const resp = await fetch(`${brainstemUrl}/__scheduled`);
        const text = await resp.text();
        return json({ ok: resp.ok, status: resp.status, body: text });
      } catch (e) {
        return json({ ok: false, error: e.message }, 502);
      }
    }

    // GET /health — system status snapshot
    if (path === "/health") {
      const [sessionCounter, wakeConfig, lastReflect, activeSession, session] =
        await Promise.all([
          env.KV.get("session_counter", "json"),
          env.KV.get("wake_config", "json"),
          env.KV.get("last_reflect", "json"),
          env.KV.get("kernel:active_session", "text"),
          env.KV.get("session", "text"),
        ]);
      return json({ sessionCounter, wakeConfig, lastReflect, session: activeSession || session });
    }

    // GET /sessions — discover all sessions (orient + deep reflect)
    if (path === "/sessions") {
      const [karmaList, reflectList, cached] = await Promise.all([
        env.KV.list({ prefix: "karma:" }),
        env.KV.list({ prefix: "reflect:1:" }),
        env.KV.get("cache:session_ids", "json"),
      ]);

      // Build set of deep reflect session IDs from reflect:1:* keys
      const deepReflectIds = new Set(
        reflectList.keys.map(k => k.name.replace("reflect:1:", ""))
      );

      // Build session list from karma keys (ground truth)
      const sessions = karmaList.keys.map(k => {
        const id = k.name.replace("karma:", "");
        return {
          id,
          type: deepReflectIds.has(id) ? "deep_reflect" : "orient",
          ts: k.metadata?.updated_at || null,
        };
      });

      // Sort by session ID (contains timestamp) — newest last
      sessions.sort((a, b) => a.id.localeCompare(b.id));

      return json({ sessions });
    }

    // GET /kv — key listing, optional ?prefix= filter
    //   Always uses live KV.list() — no cache dependency.
    if (path === "/kv") {
      const prefix = url.searchParams.get("prefix") || undefined;
      const result = await env.KV.list({ prefix });
      const keys = result.keys.map(k => ({ key: k.name, metadata: k.metadata }));
      return json({ keys });
    }

    // GET /kv/multi — batch read: ?keys=key1,key2,key3
    if (path === "/kv/multi") {
      const raw = url.searchParams.get("keys");
      if (!raw) return json({ error: "missing ?keys param" }, 400);
      const keyList = raw.split(",").map((k) => decodeURIComponent(k.trim()));
      const results = {};
      await Promise.all(
        keyList.map(async (key) => {
          const { value, metadata } = await env.KV.getWithMetadata(key, "text");
          if (value === null) { results[key] = null; return; }
          const format = metadata?.format || "json";
          if (format === "json") {
            try { results[key] = JSON.parse(value); return; } catch {}
          }
          results[key] = value;
        })
      );
      return json(results);
    }

    // GET /kv/:key — single key read
    const kvMatch = path.match(/^\/kv\/(.+)$/);
    if (kvMatch && path !== "/kv/multi") {
      const key = decodeURIComponent(kvMatch[1]);
      const { value, metadata } = await env.KV.getWithMetadata(key, "text");
      if (value === null) return json({ error: "not found" }, 404);
      const format = metadata?.format || "json";
      if (format === "json") {
        try { return json({ key, value: JSON.parse(value), type: "json" }); } catch {}
      }
      return json({ key, value, type: "text" });
    }

    return json({ error: "not found" }, 404);
  },
};
