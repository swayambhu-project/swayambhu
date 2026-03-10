import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Tool modules ─────────────────────────────────────────────

import * as send_telegram from "../tools/send_telegram.js";
import * as web_fetch from "../tools/web_fetch.js";
import * as kv_read from "../tools/kv_read.js";
import * as kv_write from "../tools/kv_write.js";
import * as kv_manifest from "../tools/kv_manifest.js";
import * as karma_query from "../tools/karma_query.js";

// ── Provider modules ─────────────────────────────────────────

import * as llm from "../providers/llm.js";
import * as llm_balance from "../providers/llm_balance.js";
import * as wallet_balance from "../providers/wallet_balance.js";

// ── Helpers ──────────────────────────────────────────────────

function mockFetch(response) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }));
}

function mockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key) => store.get(key) ?? null),
    put: vi.fn(async (key, value) => store.set(key, value)),
    list: vi.fn(async (opts = {}) => {
      let keys = [...store.keys()];
      if (opts.prefix) keys = keys.filter(k => k.startsWith(opts.prefix));
      if (opts.limit) keys = keys.slice(0, opts.limit);
      return {
        keys: keys.map(name => ({ name, metadata: null })),
        list_complete: true,
      };
    }),
    _store: store,
  };
}

// ── 1. Module structure ──────────────────────────────────────

const allTools = {
  send_telegram, web_fetch, kv_read, kv_write,
  kv_manifest, karma_query,
};

const allProviders = { llm, llm_balance, wallet_balance };

describe("module structure", () => {
  for (const [name, mod] of Object.entries(allTools)) {
    it(`tools/${name}.js exports meta and execute`, () => {
      expect(mod.meta).toBeDefined();
      expect(typeof mod.meta.timeout_ms).toBe("number");
      expect(Array.isArray(mod.meta.secrets)).toBe(true);
      expect(typeof mod.meta.kv_access).toBe("string");
      expect(typeof mod.execute).toBe("function");
    });
  }

  for (const [name, mod] of Object.entries(allProviders)) {
    it(`providers/${name}.js exports meta and call/check`, () => {
      expect(mod.meta).toBeDefined();
      expect(typeof mod.meta.timeout_ms).toBe("number");
      expect(mod.call || mod.check).toBeDefined();
    });
  }
});

// ── 2. No export default (compatible with wrapAsModule) ──────

describe("wrapAsModule compatibility", () => {
  const root = resolve(import.meta.dirname, "..");

  for (const name of Object.keys(allTools)) {
    it(`tools/${name}.js has no export default`, () => {
      const code = readFileSync(resolve(root, `tools/${name}.js`), "utf8");
      expect(code).not.toMatch(/export\s+default\s/);
    });
  }

  for (const name of Object.keys(allProviders)) {
    it(`providers/${name}.js has no export default`, () => {
      const code = readFileSync(resolve(root, `providers/${name}.js`), "utf8");
      expect(code).not.toMatch(/export\s+default\s/);
    });
  }
});

// ── 3. Tool execute() tests ──────────────────────────────────

describe("send_telegram", () => {
  it("calls Telegram API and returns response", async () => {
    const f = mockFetch({ ok: true, result: { message_id: 1 } });
    const result = await send_telegram.execute({
      text: "hello",
      secrets: { TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "123" },
      fetch: f,
    });
    expect(f).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, result: { message_id: 1 } });
    const url = f.mock.calls[0][0];
    expect(url).toContain("bot" + "tok");
  });
});

describe("web_fetch", () => {
  it("fetches URL and returns status + body", async () => {
    const f = vi.fn(async () => ({
      status: 200,
      text: async () => "page content",
    }));
    const result = await web_fetch.execute({ url: "https://example.com", fetch: f });
    expect(result.status).toBe(200);
    expect(result.body).toBe("page content");
  });

  it("truncates body beyond max_length", async () => {
    const f = vi.fn(async () => ({
      status: 200,
      text: async () => "x".repeat(200),
    }));
    const result = await web_fetch.execute({ url: "https://example.com", max_length: 50, fetch: f });
    expect(result.body.length).toBeLessThan(200);
    expect(result.body).toContain("...[truncated]");
  });
});

describe("kv_read", () => {
  it("reads key from KV", async () => {
    const kv = mockKV({ mykey: "myval" });
    const result = await kv_read.execute({ key: "mykey", kv });
    expect(result).toEqual({ key: "mykey", value: "myval" });
  });

  it("returns null for missing key", async () => {
    const kv = mockKV();
    const result = await kv_read.execute({ key: "missing", kv });
    expect(result).toEqual({ key: "missing", value: null });
  });
});

describe("kv_write", () => {
  it("writes string value", async () => {
    const kv = mockKV();
    const result = await kv_write.execute({ key: "k", value: "v", kv });
    expect(result).toEqual({ key: "k", written: true });
    expect(kv.put).toHaveBeenCalledWith("k", "v");
  });

  it("stringifies object value", async () => {
    const kv = mockKV();
    await kv_write.execute({ key: "k", value: { a: 1 }, kv });
    expect(kv.put).toHaveBeenCalledWith("k", '{"a":1}');
  });
});

describe("kv_manifest", () => {
  it("lists keys with default limit", async () => {
    const kv = mockKV({ "a:1": "v1", "a:2": "v2", "b:1": "v3" });
    const result = await kv_manifest.execute({ kv });
    expect(result.count).toBe(3);
    expect(result.list_complete).toBe(true);
  });

  it("filters by prefix", async () => {
    const kv = mockKV({ "a:1": "v1", "a:2": "v2", "b:1": "v3" });
    const result = await kv_manifest.execute({ prefix: "a:", kv });
    expect(result.count).toBe(2);
    expect(result.keys.every(k => k.key.startsWith("a:"))).toBe(true);
  });

  it("respects limit", async () => {
    const kv = mockKV({ k1: "v1", k2: "v2", k3: "v3" });
    const result = await kv_manifest.execute({ limit: "2", kv });
    expect(result.count).toBe(2);
  });

  it("caps limit at 500", async () => {
    const kv = mockKV();
    await kv_manifest.execute({ limit: "9999", kv });
    expect(kv.list).toHaveBeenCalledWith({ limit: 500 });
  });
});

// ── 4. Provider tests ────────────────────────────────────────

describe("provider:llm_balance", () => {
  it("returns limit_remaining from response", async () => {
    const f = mockFetch({ data: { limit_remaining: 42.5 } });
    const result = await llm_balance.check({
      secrets: { OPENROUTER_API_KEY: "k" },
      fetch: f,
    });
    expect(result).toBe(42.5);
  });
});

describe("provider:wallet_balance", () => {
  it("returns USDC balance as number", async () => {
    const hexBalance = "0x" + (5000000).toString(16).padStart(64, "0"); // 5 USDC
    const f = mockFetch({ result: hexBalance });
    const result = await wallet_balance.check({
      secrets: { WALLET_ADDRESS: "0x" + "ab".repeat(20) },
      fetch: f,
    });
    expect(result).toBe(5);
  });
});

// ── 5. karma_query tests ──────────────────────────────────────

const SAMPLE_KARMA = [
  { event: "session_start", session_id: "s_123", effort: "low" },
  {
    event: "llm_call", step: "orient_turn_0", ok: true,
    request: { model: "anthropic/claude-opus-4.6", messages: [{ role: "system", content: "long..." }] },
    response: { content: "hello" },
    tool_calls: [
      { type: "function", function: { name: "kv_manifest", arguments: "{}" } },
      { type: "function", function: { name: "check_balance", arguments: "{}" } },
    ],
    cost: 0.0155,
  },
  { event: "tool_result", tool: "kv_manifest", ok: true },
];

describe("karma_query", () => {
  function karmaKV(sessionId, karma) {
    return mockKV({ [`karma:${sessionId}`]: karma });
  }

  it("returns error for missing session param", async () => {
    const result = await karma_query.execute({ kv: mockKV() });
    expect(result.error).toContain("missing required param");
  });

  it("returns error for missing session in KV", async () => {
    const result = await karma_query.execute({ session: "s_none", kv: mockKV() });
    expect(result.error).toContain("no karma found");
  });

  it("returns event index with no path", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({ session: "s_123", kv });
    expect(result.count).toBe(3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toBe("0: session_start");
    expect(result.events[1]).toContain("llm_call");
    expect(result.events[1]).toContain("orient_turn_0");
    expect(result.events[1]).toContain("ok=true");
  });

  it("returns object summary for [1]", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({ session: "s_123", path: "[1]", kv });
    expect(result.type).toBe("object");
    expect(result.fields.event).toBe('"llm_call"');
    expect(result.fields.cost).toBe("0.0155");
    expect(result.fields.tool_calls).toContain("array");
    expect(result.fields.request).toContain("object");
  });

  it("returns array summary for [1].tool_calls", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({ session: "s_123", path: "[1].tool_calls", kv });
    expect(result.type).toBe("array");
    expect(result.count).toBe(2);
    expect(result.items[0]).toContain("kv_manifest");
    expect(result.items[1]).toContain("check_balance");
  });

  it("returns leaf value for deep path", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({
      session: "s_123",
      path: "[1].tool_calls[0].function.name",
      kv,
    });
    expect(result.value).toBe("kv_manifest");
  });

  it("returns leaf for numeric value", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({ session: "s_123", path: "[1].cost", kv });
    expect(result.value).toBe(0.0155);
  });

  it("returns error for out-of-bounds index", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({ session: "s_123", path: "[99]", kv });
    expect(result.error).toContain("out of bounds");
  });

  it("returns error with available_keys for missing key", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({ session: "s_123", path: "[0].nonexistent", kv });
    expect(result.error).toContain("not found");
    expect(result.available_keys).toContain("event");
  });

  it("returns error for bad path syntax", async () => {
    const kv = karmaKV("s_123", SAMPLE_KARMA);
    const result = await karma_query.execute({ session: "s_123", path: "[abc]", kv });
    expect(result.error).toContain("non-numeric");
  });

  it("truncates long strings with full_length", async () => {
    const longKarma = [{ event: "test", data: "x".repeat(200) }];
    const kv = karmaKV("s_long", longKarma);
    const result = await karma_query.execute({ session: "s_long", path: "[0].data", kv });
    expect(result.value.length).toBeLessThan(200);
    expect(result.full_length).toBe(200);
  });

  it("handles string-encoded karma (JSON string in KV)", async () => {
    const kv = mockKV({ "karma:s_str": JSON.stringify(SAMPLE_KARMA) });
    // mockKV.get returns raw value — but real KV might return parsed or string
    // karma_query handles both cases
    const result = await karma_query.execute({ session: "s_str", kv });
    expect(result.count).toBe(3);
  });
});
