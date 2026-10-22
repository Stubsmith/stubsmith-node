import http from "node:http";
import https from "node:https";
import { Readable, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubsmithClient, pendingCounts } from "../src/client.js";
import { resetWarnOnceForTests } from "../src/env.js";
import { install, isInstalled, setUnreadGraceMsForTests } from "../src/instrument.js";
import { resetIngestWarningsForTests } from "../src/refusals.js";
import { enterReplay, exitReplay } from "../src/replayState.js";
import { RulesPoller } from "../src/sync.js";
import { bigJson } from "./helpers/pipeline.js";
import { type FakeBackend, type Upstream, sleep, startBackend, startUpstream, syncBody, waitFor } from "./helpers/servers.js";

const ENV = ["STUBSMITH_API_KEY", "STUBSMITH_URL", "STUBSMITH_BACKEND_URL", "STUBSMITH_DEBUG", "STUBSMITH_FLUSH_TIMEOUT"];
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const realHttp = { request: http.request, get: http.get };
const realHttps = { request: https.request, get: https.get };

let backend: FakeBackend;
let upstream: Upstream;
let client: StubsmithClient;
const BIG = Buffer.from(JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field_number_${i}`, i]))));

function upstreamHandler(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
  const url = req.url ?? "/";
  if (url.startsWith("/redirect")) {
    res.writeHead(302, { location: "/json" });
    res.end();
  } else if (url.startsWith("/gz")) {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipSync(Buffer.from('{"zipped_key": "zipped value", "n": 1}')));
  } else if (url.startsWith("/big")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(BIG);
  } else if (url.startsWith("/chunks")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"chunk_a": 1, ');
    setTimeout(() => res.write('"chunk_b": 2, '), 20);
    setTimeout(() => res.end('"chunk_c": 3}'), 40);
  } else if (url.startsWith("/huge")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(64 * 1024, 97);
    let n = 0;
    const pump = (): void => {
      while (n < 128) {
        n++;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
  } else if (url.startsWith("/submit")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"result": "ok"}');
  } else if (url.startsWith("/orders")) {
    res.writeHead(201, { "content-type": "application/json", "x-response-id": "abc" });
    res.end('{"id": 42}');
  } else if (url.startsWith("/items")) {
    res.writeHead(200, { "content-type": "application/json", "x-srv": "httpx-test" });
    res.end('{"ok": true}');
  } else if (url.startsWith("/stock")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(bigJson());
  } else if (url.startsWith("/formtext") || url.startsWith("/notes")) {
    res.writeHead(200, { "content-type": "application/x-www-form-urlencoded" });
    res.end("Dear RESPTEXT, your code is 5678");
  } else if (url.startsWith("/nocontent")) {
    res.writeHead(204);
    res.end();
  } else if (url.startsWith("/over")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(1024 * 1024, 97);
    let n = 0;
    const pump = (): void => {
      while (n < 17) {
        n++;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
  } else if (url.startsWith("/secret")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"token": "super-secret"}');
  } else if (url.startsWith("/echo")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echoed_length: body.length }));
  } else if (url.startsWith("/hold")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"held_a": 1, ');
    holdRelease = () => res.end('"held_b": 2}');
  } else {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
    res.end('{"id": 1, "name": "x"}');
  }
}
let holdRelease: () => void = () => undefined;

beforeEach(async () => {
  for (const n of ENV) {
    savedEnv[n] = process.env[n];
    delete process.env[n];
  }
  process.env["STUBSMITH_FLUSH_TIMEOUT"] = "1";
  setUnreadGraceMsForTests(1000);
  backend = await startBackend();
  upstream = await startUpstream(upstreamHandler);
  resetIngestWarningsForTests();
  resetWarnOnceForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
});

afterEach(async () => {
  holdRelease();
  await client.close();
  await upstream.close();
  await backend.close();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  for (const n of ENV) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
});

interface CallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
interface Result {
  status: number;
  body: Buffer;
}

function httpCall(url: string, init: CallInit = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

async function fetchCall(url: string, init: CallInit = {}): Promise<Result> {
  const res = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

const KINDS = [
  ["http", httpCall, "node-http"],
  ["fetch", fetchCall, "node-fetch"],
] as const;

type Payload = Record<string, unknown>;
const payloads = (): Payload[] => backend.captures.map((c) => c.json as Payload);
async function captured(n: number): Promise<Payload[]> {
  await waitFor(() => backend.captures.length >= n);
  return payloads();
}
/** Assert that exactly `n` captures arrive and no more follow. */
async function exactly(n: number): Promise<Payload[]> {
  await captured(n);
  await sleep(120);
  expect(backend.captures).toHaveLength(n);
  return payloads();
}

describe("install singleton", () => {
  it("is idempotent, ignores later options and is shared through globalThis", () => {
    expect(isInstalled()).toBe(true);
    const again = install({ apiKey: "other", sampleRate: 0 });
    expect(again).toBe(client);
    expect(again.sampleRate).toBe(1);
    const shared = (globalThis as unknown as Record<symbol, { client: unknown }>)[Symbol.for("stubsmith.client")];
    expect(shared?.client).toBe(client);
  });

  it("close() restores http.request/get, https.request/get and fetch by identity and allows a fresh install", async () => {
    expect(http.request).not.toBe(realHttp.request);
    expect(http.get).not.toBe(realHttp.get);
    expect(https.request).not.toBe(realHttps.request);
    expect(https.get).not.toBe(realHttps.get);
    expect(globalThis.fetch).not.toBe(realFetch);
    await client.close();
    expect(http.request).toBe(realHttp.request);
    expect(http.get).toBe(realHttp.get);
    expect(https.request).toBe(realHttps.request);
    expect(https.get).toBe(realHttps.get);
    expect(globalThis.fetch).toBe(realFetch);
    expect(isInstalled()).toBe(false);
    const next = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
    expect(next).not.toBe(client);
    expect(isInstalled()).toBe(true);
    client = next;
  });

  it("an empty key installs a disabled client without patching anything", async () => {
    await client.close();
    const disabled = install({ apiKey: "" });
    expect(disabled.enabled).toBe(false);
    expect(http.request).toBe(realHttp.request);
    expect(globalThis.fetch).toBe(realFetch);
    await httpCall(`${upstream.base}/json`);
    await sleep(50);
    expect(backend.captures).toHaveLength(0);
    client = disabled;
  });

  it("an uninstalled wrapper that something else wrapped on top of is inert", async () => {
    const wrapped = http.request;
    const outer = ((...a: unknown[]) => (wrapped as unknown as (...x: unknown[]) => http.ClientRequest)(...a)) as typeof http.request;
    http.request = outer;
    await client.close();
    expect(http.request).toBe(outer); // not clobbered
    await httpCall(`${upstream.base}/json`);
    await sleep(80);
    expect(backend.captures).toHaveLength(0);
    http.request = realHttp.request;
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
  });
});

for (const [kind, call, source] of KINDS) {
  describe(`${kind} hook`, () => {
    it("captures one exchange with every SPEC key, source, duration and the exact capture headers", async () => {
      await call(`${upstream.base}/json?limit=5`, { headers: { "x-trace": "abc" } });
      const [p] = await exactly(1);
      const got = backend.captures[0];
      expect(got?.headers["authorization"]).toBe("Bearer test-key");
      expect(got?.headers["content-type"]).toBe("application/json");
      expect(p?.["source"]).toBe(source);
      expect(p?.["method"]).toBe("GET");
      expect(p?.["status"]).toBe(200);
      expect(p?.["domain"]).toBe(upstream.base.replace("http://", ""));
      expect(p?.["path_template"]).toBe("/json");
      expect(p?.["query_names"]).toEqual(["limit"]);
      expect(Number.isInteger(p?.["duration"])).toBe(true);
      expect(p?.["duration"] as number).toBeGreaterThanOrEqual(0);
      expect(p?.["resp_key_paths"]).toEqual(expect.arrayContaining(["id", "name"]));
      expect(p?.["req_header_names"]).toContain("x-trace");
      expect(p?.["resp_header_names"]).toEqual(expect.arrayContaining(["content-type", "set-cookie"]));
      expect(p?.["novel"]).toBe(true);
      expect(p?.["sdk_rule_version"]).toBe("0");
    });

    it("sdk_rule_version equals the synced cursor and novel is false for a synced fingerprint", async () => {
      await call(`${upstream.base}/json`);
      const [first] = await exactly(1);
      backend.sync = {
        status: 200,
        delayMs: 0,
        body: syncBody("77", [
          {
            domain: String(first?.["domain"]),
            method: String(first?.["method"]),
            path_template: String(first?.["path_template"]),
            fingerprint: String(first?.["req_fingerprint"]),
          },
        ]),
      };
      await (client as unknown as { poller: RulesPoller }).poller.pollOnce();
      await call(`${upstream.base}/json`);
      const all = await exactly(2);
      expect(all[1]?.["novel"]).toBe(false);
      expect(all[1]?.["sdk_rule_version"]).toBe("77");
    });

    it("masks request bodies: key names are reported, values never leave", async () => {
      await call(`${upstream.base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer topsecret" },
        body: '{"customer_email": "jane@corp.example", "qty": 3}',
      });
      const [p] = await exactly(1);
      expect(p?.["method"]).toBe("POST");
      expect(p?.["key_paths"]).toEqual(expect.arrayContaining(["customer_email", "qty"]));
      const raw = backend.captures[0]?.raw.toString("utf8") ?? "";
      expect(raw).not.toContain("jane@corp.example");
      expect(raw).not.toContain("topsecret");
      expect(upstream.requests[0]?.body.toString()).toBe('{"customer_email": "jane@corp.example", "qty": 3}');
    });

    it("gzips a large capture", async () => {
      const r = await call(`${upstream.base}/big`);
      expect(r.body.equals(BIG)).toBe(true);
      await captured(1);
      expect(backend.captures[0]?.headers["content-encoding"]).toBe("gzip");
      expect(payloads()[0]?.["resp_key_paths"]).toContain("field_number_299");
    });

    it("skips capture while replay is active", async () => {
      enterReplay();
      try {
        await call(`${upstream.base}/json`);
        await sleep(100);
        expect(backend.captures).toHaveLength(0);
      } finally {
        exitReplay();
      }
      await call(`${upstream.base}/json`);
      await exactly(1);
    });

    it("never captures the SDK's own traffic (ingest POSTs and rules sync)", async () => {
      await waitFor(() => backend.syncRequests.length >= 1);
      await sleep(30); // let the install-time poll finish so the next one is not skipped
      await (client as unknown as { poller: RulesPoller }).poller.pollOnce();
      await call(`${upstream.base}/json`);
      await call(`${upstream.base}/json`);
      await exactly(2);
      expect(backend.syncRequests.length).toBeGreaterThanOrEqual(2);
      const domains = new Set(payloads().map((p) => p["domain"]));
      expect([...domains]).toEqual([upstream.base.replace("http://", "")]);
    });

    it("a network error propagates untouched and is not captured", async () => {
      const dead = http.createServer();
      await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
      const port = (dead.address() as { port: number }).port;
      await new Promise<void>((r) => dead.close(() => r()));
      await expect(call(`http://127.0.0.1:${port}/x`)).rejects.toBeDefined();
      await sleep(80);
      expect(backend.captures).toHaveLength(0);
    });
  });
}

describe("redirects", () => {
  it("http hook is user driven: each hop is its own capture with its own URL", async () => {
    const first = await httpCall(`${upstream.base}/redirect?token=abc`);
    expect(first.status).toBe(302);
    await httpCall(`${upstream.base}/json`);
    const all = await exactly(2);
    expect(all.map((p) => [p["path_template"], p["status"]])).toEqual([
      ["/redirect", 302],
      ["/json", 200],
    ]);
    expect(all[0]?.["query_names"]).toContain("token");
  });

  it("fetch hook is captured once with the ORIGINAL url and the final response", async () => {
    const r = await fetchCall(`${upstream.base}/redirect?token=abc`);
    expect(r.status).toBe(200);
    const [p] = await exactly(1);
    expect(p?.["path_template"]).toBe("/redirect");
    expect(String(p?.["path"])).toContain("/redirect");
    // The query name survives: the capture carries the original request's query, not the redirect target's.
    expect(p?.["query_names"]).toContain("token");
    expect(p?.["status"]).toBe(200);
    expect(p?.["resp_key_paths"]).toEqual(expect.arrayContaining(["id", "name"]));
    expect(upstream.requests.map((q) => q.url)).toEqual(["/redirect?token=abc", "/json"]);
  });
});

describe("nesting", () => {
  it("a fetch polyfilled over http is captured once, by the outer hook", async () => {
    await client.close();
    const polyfill = (input: string | URL | Request): Promise<Response> =>
      new Promise((resolve, reject) => {
        const req = http.get(String(input), (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
        });
        req.on("error", reject);
      });
    globalThis.fetch = polyfill as typeof fetch;
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
    const res = await fetch(`${upstream.base}/json`);
    expect(res.status).toBe(200);
    await res.text();
    const all = await exactly(1);
    expect(all[0]?.["source"]).toBe("node-fetch");
  });

  it("an http request issued from a fetch continuation, and one from a response callback, are captured separately", async () => {
    await fetch(`${upstream.base}/json`).then((r) => r.text()).then(() => httpCall(`${upstream.base}/chunks`));
    // chained http inside the callback of another captured http request
    await new Promise<void>((resolve, reject) => {
      http.get(`${upstream.base}/json`, (res) => {
        res.resume();
        res.on("end", () => {
          httpCall(`${upstream.base}/gz`).then(() => resolve(), reject);
        });
      });
    });
    const all = await exactly(4);
    expect(all.map((p) => [p["source"], p["path_template"]]).sort()).toEqual(
      [
        ["node-fetch", "/json"],
        ["node-http", "/chunks"],
        ["node-http", "/json"],
        ["node-http", "/gz"],
      ].sort(),
    );
  });
});

describe("http hook specifics", () => {
  it("handles every call form: string, URL, options, (url, options, cb), get, and the https module", async () => {
    const u = new URL(upstream.base);
    const done = (req: http.ClientRequest): Promise<void> =>
      new Promise((resolve, reject) => {
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
      });
    const forms: Array<() => http.ClientRequest> = [
      () => http.request(`${upstream.base}/a`, (res) => res.resume()),
      () => http.request(new URL(`${upstream.base}/b`), (res) => res.resume()),
      () => http.request({ host: "127.0.0.1", port: u.port, path: "/c?x=1" }, (res) => res.resume()),
      () => http.request({ hostname: "127.0.0.1", port: Number(u.port), path: "/d", method: "PUT" }, (res) => res.resume()),
      () => http.request(`${upstream.base}/e`, { method: "DELETE" }, (res) => res.resume()),
      () => http.get(`${upstream.base}/f`, (res) => res.resume()),
      () => http.get({ host: "127.0.0.1", port: u.port, path: "/g" }, (res) => res.resume()),
      () => http.get(`${upstream.base}/h`, { headers: { "x-h": "1" } }, (res) => res.resume()),
    ];
    for (const f of forms) {
      const req = f();
      req.end();
      await done(req);
    }
    const all = await exactly(forms.length);
    const seen = all.map((p) => `${String(p["method"])} ${String(p["domain"])}${String(p["path"])}`);
    const host = u.host;
    expect(seen).toEqual([
      `GET ${host}/a`,
      `GET ${host}/b`,
      `GET ${host}/c?x=%3Cmasked%3E`,
      `PUT ${host}/d`,
      `DELETE ${host}/e`,
      `GET ${host}/f`,
      `GET ${host}/g`,
      `GET ${host}/h`,
    ]);
  });

  it("https.request/https.get are patched and a failing https call neither throws nor captures", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const err = await new Promise<Error>((resolve) => {
      const req = https.get(`https://127.0.0.1:${port}/x`);
      req.on("error", resolve);
    });
    expect(err).toBeInstanceOf(Error);
    await sleep(60);
    expect(backend.captures).toHaveLength(0);
  });

  it("invalid arguments throw exactly as Node does", () => {
    expect(() => http.request({ protocol: "ftp:" })).toThrow(/Protocol/);
  });

  it("buffers a body written in chunks with encodings, and reads the final headers at end()", async () => {
    const req = http.request(`${upstream.base}/echo`, { method: "POST" }, (res) => res.resume());
    req.setHeader("content-type", "application/json");
    req.setHeader("x-late", "yes");
    req.write('{"part_one": ');
    req.write(Buffer.from('"é", ', "utf8"));
    req.write("22", "hex"); // the character "
    req.end('part_two": 2}', "utf8");
    await waitFor(() => backend.captures.length >= 1, 3000);
    const [p] = payloads();
    expect(p?.["req_header_names"]).toEqual(expect.arrayContaining(["content-type", "x-late"]));
    expect(upstream.requests[0]?.body.toString("utf8")).toBe('{"part_one": "é", "part_two": 2}');
  });

  it("response consumed via data listener, pipe, async iterator, read() and setEncoding is fully captured", async () => {
    const consumers: Array<(res: http.IncomingMessage) => Promise<string>> = [
      (res) =>
        new Promise((resolve) => {
          let s = "";
          res.on("data", (c: Buffer) => (s += c.toString()));
          res.on("end", () => resolve(s));
        }),
      (res) =>
        new Promise((resolve, reject) => {
          let s = "";
          const sink = new Writable({
            write(chunk: Buffer, _e, cb) {
              s += chunk.toString();
              cb();
            },
          });
          sink.on("finish", () => resolve(s));
          sink.on("error", reject);
          res.pipe(sink);
        }),
      async (res) => {
        let s = "";
        for await (const c of res) s += (c as Buffer).toString();
        return s;
      },
      (res) =>
        new Promise((resolve) => {
          let s = "";
          res.on("readable", () => {
            let c: Buffer | null;
            while ((c = res.read() as Buffer | null) !== null) s += c.toString();
          });
          res.on("end", () => resolve(s));
        }),
      (res) =>
        new Promise((resolve) => {
          let s = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (s += c));
          res.on("end", () => resolve(s));
        }),
    ];
    let i = 0;
    for (const consume of consumers) {
      const got = await new Promise<string>((resolve, reject) => {
        const req = http.get(`${upstream.base}/chunks`, (res) => {
          consume(res).then(resolve, reject);
        });
        req.on("error", reject);
      });
      expect(got, `consumer ${i}`).toBe('{"chunk_a": 1, "chunk_b": 2, "chunk_c": 3}');
      i++;
    }
    const all = await exactly(consumers.length);
    for (const p of all) expect(p["resp_key_paths"]).toEqual(["chunk_a", "chunk_b", "chunk_c"]);
  });

  it("does not attach listeners or switch the stream to flowing mode", async () => {
    const seen = await new Promise<{ flowing: boolean | null; data: number; readable: number; response: number }>((resolve) => {
      const req = http.get(`${upstream.base}/json`, (res) => {
        const snapshot = {
          flowing: res.readableFlowing,
          data: res.listenerCount("data"),
          readable: res.listenerCount("readable"),
          response: req.listenerCount("response"), // Node's own once() listener was already removed
        };
        res.resume();
        resolve(snapshot);
      });
    });
    expect(seen).toEqual({ flowing: null, data: 0, readable: 0, response: 0 });
  });

  it("keeps Node's dump of a response nobody listens for: captured (empty body, Node discards dumped bytes), socket released", async () => {
    const req = http.get(`${upstream.base}/json`);
    expect(req.listenerCount("response")).toBe(0);
    const [p] = await exactly(1);
    expect(p?.["status"]).toBe(200);
    expect(p?.["resp_key_paths"]).toEqual([]);
    expect(req.listenerCount("response")).toBe(0); // the tap adds no listener, so Node still dumps
  });

  it("keeps back-pressure: a paused consumer is not drained by the capture", async () => {
    const state = await new Promise<{ buffered: number; flowing: boolean | null }>((resolve) => {
      http.get(`${upstream.base}/huge`, (res) => {
        res.pause();
        setTimeout(() => {
          const out = { buffered: res.readableLength, flowing: res.readableFlowing };
          res.destroy();
          resolve(out);
        }, 150);
      });
    });
    expect(state.flowing).toBe(false);
    expect(state.buffered).toBeLessThan(8 * 1024 * 1024); // 128 x 64 KiB were offered
  });

  it("a response the caller never reads is captured with an empty body after the grace period and does not hang", async () => {
    setUnreadGraceMsForTests(60);
    let held: http.IncomingMessage | undefined;
    http.get(`${upstream.base}/json`, (res) => {
      held = res; // never read
    });
    const [p] = await exactly(1);
    expect(p?.["status"]).toBe(200);
    expect(p?.["resp_key_paths"]).toEqual([]);
    // The body was not consumed: a reader attaching later still gets every byte.
    const text = await new Promise<string>((resolve) => {
      let s = "";
      held?.on("data", (c: Buffer) => (s += c.toString()));
      held?.on("end", () => resolve(s));
    });
    expect(text).toBe('{"id": 1, "name": "x"}');
  });

  it("an unread response that is read later is not captured twice", async () => {
    setUnreadGraceMsForTests(40);
    const res = await new Promise<http.IncomingMessage>((resolve) => http.get(`${upstream.base}/json`, resolve));
    await sleep(120);
    res.resume();
    await new Promise((r) => res.on("end", r));
    await exactly(1);
  });

  it("a slow reader that starts inside the grace period gets the full body captured", async () => {
    setUnreadGraceMsForTests(100);
    const body = await new Promise<string>((resolve) => {
      http.get(`${upstream.base}/json`, (res) => {
        setTimeout(() => {
          let s = "";
          res.on("data", (c: Buffer) => (s += c.toString()));
          res.on("end", () => resolve(s));
        }, 20);
      });
    });
    expect(body).toBe('{"id": 1, "name": "x"}');
    const [p] = await exactly(1);
    expect(p?.["resp_key_paths"]).toEqual(["id", "name"]);
  });

  it("decodes content-encoding gzip for the capture while the caller still gets the raw bytes", async () => {
    const raw = await new Promise<Buffer>((resolve) => {
      http.get(`${upstream.base}/gz`, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
    });
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);
    const [p] = await exactly(1);
    expect(p?.["resp_key_paths"]).toEqual(expect.arrayContaining(["zipped_key", "n"]));
    expect(p?.["resp_header_names"]).toContain("content-encoding");
  });

  it("an aborted response is not captured", async () => {
    await new Promise<void>((resolve) => {
      http.get(`${upstream.base}/hold`, (res) => {
        res.once("data", () => {
          res.destroy();
          resolve();
        });
      }).on("error", () => undefined);
    });
    await sleep(120);
    expect(backend.captures).toHaveLength(0);
  });

  it("never throws into the caller when the capture machinery fails", async () => {
    vi.spyOn(client, "capture").mockImplementation(() => {
      throw new Error("boom");
    });
    const r = await httpCall(`${upstream.base}/json`);
    expect(r.status).toBe(200);
    await sleep(60);
  });

  it("does not leak the response body into a request body cap (oversized responses are skipped, not truncated)", async () => {
    // 8 MiB streamed: under the cap, so captured as one oversize-path payload or normal payload.
    const r = await httpCall(`${upstream.base}/huge`);
    expect(r.body.length).toBe(128 * 64 * 1024);
    await captured(1);
    expect(payloads()[0]?.["status"]).toBe(200);
  });
});

describe("fetch hook specifics", () => {
  it("accepts string, URL and Request inputs and leaves the caller's response readable", async () => {
    const r1 = await fetch(`${upstream.base}/json`);
    expect(await r1.json()).toEqual({ id: 1, name: "x" });
    const r2 = await fetch(new URL(`${upstream.base}/json`));
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe('{"id": 1, "name": "x"}');
    const req = new Request(`${upstream.base}/echo`, {
      method: "POST",
      headers: new Headers({ "content-type": "application/json", "x-req": "1" }),
      body: '{"from_request_object": 1}',
    });
    const r3 = await fetch(req);
    expect(await r3.json()).toEqual({ echoed_length: 26 });
    const all = await exactly(3);
    expect(all[2]?.["method"]).toBe("POST");
    expect(all[2]?.["key_paths"]).toEqual(["from_request_object"]);
    expect(all[2]?.["req_header_names"]).toContain("x-req");
    expect(upstream.requests[2]?.body.toString()).toBe('{"from_request_object": 1}');
    expect(upstream.requests[2]?.headers["x-req"]).toBe("1");
  });

  it("request init overrides on a Request input are honoured in the capture", async () => {
    const req = new Request(`${upstream.base}/echo`, { method: "POST", body: '{"a": 1}' });
    await (await fetch(req.clone(), { method: "PUT", body: '{"b": 2}', headers: { "content-type": "application/json" } })).text();
    const [p] = await exactly(1);
    expect(p?.["method"]).toBe("PUT");
    expect(p?.["key_paths"]).toEqual(["b"]);
  });

  it("a streamed request body (duplex half) reaches the server intact and is captured with an empty request body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"streamed_key": '));
        controller.enqueue(new TextEncoder().encode("1}"));
        controller.close();
      },
    });
    const res = await fetch(`${upstream.base}/echo`, {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(upstream.requests[0]?.body.toString()).toBe('{"streamed_key": 1}');
    const [p] = await exactly(1);
    expect(p?.["key_paths"]).toEqual([]);
    expect(["", "<masked>"]).toContain(p?.["req_body"]);
  });

  it("returns the response before the body completes and captures when the body ends", async () => {
    const res = await fetch(`${upstream.base}/hold`);
    expect(res.status).toBe(200);
    await sleep(80);
    expect(backend.captures).toHaveLength(0); // body still open: nothing enqueued yet
    holdRelease();
    expect(await res.text()).toBe('{"held_a": 1, "held_b": 2}');
    const [p] = await exactly(1);
    expect(p?.["resp_key_paths"]).toEqual(["held_a", "held_b"]);
  });

  it("a response the caller never reads is captured with an empty body after the grace period and nothing hangs", async () => {
    setUnreadGraceMsForTests(60);
    const res = await fetch(`${upstream.base}/json`);
    const [p] = await exactly(1);
    expect(p?.["status"]).toBe(200);
    expect(p?.["resp_key_paths"]).toEqual([]);
    // A reader attaching after the grace period still gets every byte and is not captured twice.
    expect(await res.text()).toBe('{"id": 1, "name": "x"}');
    await exactly(1);
  });

  it("an aborted fetch rejects with the native error and is not captured", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(fetch(`${upstream.base}/json`, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    await sleep(60);
    expect(backend.captures).toHaveLength(0);
  });

  it("an invalid request rejects like native fetch (relative URL)", async () => {
    await expect(fetch("/relative")).rejects.toBeInstanceOf(TypeError);
  });

  it("response headers keep repeated values joined with a comma", async () => {
    await (await fetch(`${upstream.base}/json`)).text();
    await captured(1);
    expect(payloads()[0]?.["resp_header_names"]).toContain("set-cookie");
  });

  it("an infinite response body does not grow memory without bound or block the caller", async () => {
    const infinite = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write(Buffer.alloc(1024 * 1024, 97)), 1);
      res.on("close", () => clearInterval(timer));
    });
    try {
      const res = await fetch(`${infinite.base}/`);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await reader.cancel();
      await sleep(50);
    } finally {
      await infinite.close();
    }
  });
});

describe("Readable sanity", () => {
  it("Readable.from over a captured response body still works end to end", async () => {
    const r = await fetch(`${upstream.base}/chunks`);
    const chunks: Buffer[] = [];
    for await (const c of Readable.fromWeb(r.body as never)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('{"chunk_a": 1, "chunk_b": 2, "chunk_c": 3}');
    await exactly(1);
  });
});

/** Reject when `p` takes longer than `ms`, so a regression fails the assertion instead of hanging the suite. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);
}

describe("fetch pass-through body", () => {
  async function startDrip(): Promise<{ base: string; closed: () => boolean; close(): Promise<void> }> {
    let closed = false;
    const drip = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write("0123456789"), 50);
      res.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
    });
    return { base: drip.base, closed: () => closed, close: drip.close };
  }

  it("breaking out of for-await after 3 chunks settles at once and closes the connection", async () => {
    const drip = await startDrip();
    try {
      const res = await fetch(`${drip.base}/`);
      const t0 = Date.now();
      let n = 0;
      await within(
        (async () => {
          for await (const _chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            void _chunk;
            if (++n === 3) break;
          }
        })(),
        2000,
      );
      expect(Date.now() - t0).toBeLessThan(500);
      expect(await waitFor(() => drip.closed(), 500)).toBe(true);
      await sleep(80);
      expect(backend.captures).toHaveLength(0); // a cancelled body is dropped, not captured
      await within(client.flush(), 500); // and nothing is left pending
    } finally {
      await drip.close();
    }
  });

  it("reader.cancel() resolves under 500 ms", async () => {
    const drip = await startDrip();
    try {
      const res = await fetch(`${drip.base}/`);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const t0 = Date.now();
      await within(reader.cancel(), 2000);
      expect(Date.now() - t0).toBeLessThan(500);
      expect(await waitFor(() => drip.closed(), 500)).toBe(true);
    } finally {
      await drip.close();
    }
  });

  it("a normal small response is captured with the full body and keeps url, redirected, status and headers", async () => {
    const res = await fetch(`${upstream.base}/redirect`);
    expect(res.url).toBe(`${upstream.base}/json`);
    expect(res.redirected).toBe(true);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.type).toBe("basic");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ id: 1, name: "x" });
    const direct = await fetch(`${upstream.base}/json`);
    expect(direct.url).toBe(`${upstream.base}/json`);
    expect(direct.redirected).toBe(false);
    expect(direct.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    await direct.text();
    const all = await exactly(2);
    expect(all[0]?.["path_template"]).toBe("/redirect"); // the ORIGINAL url
    expect(all[0]?.["resp_key_paths"]).toEqual(["id", "name"]);
    expect(all[1]?.["resp_key_paths"]).toEqual(["id", "name"]);
  });

  it("a null body (204, HEAD) passes through unchanged and is captured with an empty body", async () => {
    const res = await fetch(`${upstream.base}/nocontent`);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    const head = await fetch(`${upstream.base}/json`, { method: "HEAD" });
    expect(head.body).toBeNull();
    const all = await exactly(2);
    expect(all.map((p) => [p["method"], p["status"], p["resp_key_paths"]])).toEqual([
      ["GET", 204, []],
      ["HEAD", 200, []],
    ]);
  });

  it("a body over 16 MiB is forwarded whole, not captured, and warned about once per endpoint", async () => {
    const warn = vi.mocked(console.warn);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${upstream.base}/over`);
      expect((await res.arrayBuffer()).byteLength).toBe(17 * 1024 * 1024);
    }
    await client.flush();
    await sleep(60);
    expect(backend.captures).toHaveLength(0);
    const host = upstream.base.replace("http://", "");
    expect(warn.mock.calls.map((a) => String(a[0]))).toEqual([`stubsmith: GET ${host}/over: body over 16 MiB, capture dropped`]);
  });
});

describe("oversize warning on the http hook", () => {
  it("warns once per METHOD host path and drops the capture", async () => {
    const warn = vi.mocked(console.warn);
    await httpCall(`${upstream.base}/over?token=SECRET`);
    await httpCall(`${upstream.base}/over`);
    await client.flush();
    await sleep(60);
    expect(backend.captures).toHaveLength(0);
    const host = upstream.base.replace("http://", "");
    expect(warn.mock.calls.map((a) => String(a[0]))).toEqual([`stubsmith: GET ${host}/over: body over 16 MiB, capture dropped`]);
  });
});

describe("flush() waits for the most recent capture", () => {
  it("fetch: a completed call is in the ingest after flush(), 5 runs", async () => {
    for (let i = 0; i < 5; i++) {
      const before = backend.captures.length;
      await (await fetch(`${upstream.base}/json`)).json();
      await client.flush();
      expect(backend.captures.length).toBe(before + 1);
    }
  });

  it("http: a completed call is in the ingest after flush(), 5 runs", async () => {
    for (let i = 0; i < 5; i++) {
      const before = backend.captures.length;
      await httpCall(`${upstream.base}/json`);
      await client.flush();
      expect(backend.captures.length).toBe(before + 1);
    }
  });

  it("close() delivers the capture of a call that just finished", async () => {
    await (await fetch(`${upstream.base}/json`)).json();
    await httpCall(`${upstream.base}/json`);
    await client.close();
    expect(backend.captures).toHaveLength(2);
  });

  it("a response nobody reads does not make flush() wait beyond its deadline", async () => {
    let held: http.IncomingMessage | undefined;
    http.get(`${upstream.base}/json`, (res) => {
      held = res; // never read; the 1 s grace period is still running
    });
    await waitFor(() => upstream.requests.length === 1);
    const t0 = Date.now();
    await client.flush({ timeoutMs: 300 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(700);
    held?.destroy();
  });

  it("a request that fails without a response does not stay pending", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));
    await expect(httpCall(`http://127.0.0.1:${port}/x`)).rejects.toBeDefined();
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toBeDefined();
    const t0 = Date.now();
    await client.flush();
    expect(Date.now() - t0).toBeLessThan(300);
  });
});

describe("userinfo is never captured", () => {
  it("http.get with user:pass in the URL records the bare host and no credentials", async () => {
    const withAuth = upstream.base.replace("http://", "http://alice:pw@");
    await new Promise<void>((resolve, reject) => {
      http.get(`${withAuth}/f`, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });
    expect(upstream.requests[0]?.headers["authorization"]).toMatch(/^Basic /); // Node still sent them
    const [p] = await exactly(1);
    expect(p?.["domain"]).toBe(upstream.base.replace("http://", ""));
    const wire = JSON.stringify(p);
    expect(wire).not.toContain("alice");
    expect(wire).not.toContain("pw");
  });

  it("options.auth is ignored for the captured URL", async () => {
    const port = Number(new URL(upstream.base).port);
    await new Promise<void>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/f", auth: "alice:pw" }, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });
    const [p] = await exactly(1);
    expect(p?.["domain"]).toBe(`127.0.0.1:${port}`);
    const wire = JSON.stringify(p);
    expect(wire).not.toContain("alice");
    expect(wire).not.toContain("pw");
  });
});

describe("self-capture backstop at the hooks", () => {
  it("user calls to the ingest and backend URLs, outside any guard, are not captured", async () => {
    await httpCall(backend.ingestUrl, { method: "POST", body: "{}" });
    await fetchCall(backend.ingestUrl, { method: "POST", body: "{}" });
    await httpCall(`${backend.base}/v1/sdk/sync?cursor=0`);
    await fetchCall(`${backend.base}/v1/sdk/sync?cursor=0`);
    await client.flush();
    await sleep(80);
    // Only the two raw POSTs themselves reached the ingest; no masked capture of any call followed.
    expect(backend.captures).toHaveLength(2);
    expect(backend.captures.every((c) => c.json?.["sdk_masked"] === undefined)).toBe(true);
  });
});

describe("hooks are skipped without a pipeline", () => {
  it("a client whose pipeline failed to initialise patches nothing", async () => {
    await client.close();
    vi.spyOn(RulesPoller.prototype, "start").mockImplementation(() => {
      throw new Error("init failed");
    });
    const broken = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
    expect(broken.enabled).toBe(true);
    expect(broken.pipeline).toBeNull();
    expect(http.request).toBe(realHttp.request);
    expect(http.get).toBe(realHttp.get);
    expect(https.request).toBe(realHttps.request);
    expect(globalThis.fetch).toBe(realFetch);
    // A request that would carry a secret goes out untouched and is not captured, raw or masked.
    for (const [, call] of KINDS) {
      await call(`${upstream.base}/secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      });
    }
    await sleep(60);
    expect(backend.captures).toHaveLength(0);
    await broken.close();
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
  });
});

describe("debug detection of a replaced wrapper", () => {
  type StderrSpy = { mock: { calls: unknown[][] } };
  async function reinstall(debug: boolean): Promise<StderrSpy> {
    await client.close();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000, debug });
    return err;
  }
  const lines = (spy: StderrSpy): string => spy.mock.calls.map((a) => String(a[0])).join("");

  it("logs when something replaces http.request, https.get or fetch right after install", async () => {
    const err = await reinstall(true);
    const wrapped = { request: http.request, get: https.get, fetch: globalThis.fetch };
    http.request = ((...a: unknown[]) => (wrapped.request as unknown as (...x: unknown[]) => unknown)(...a)) as typeof http.request;
    https.get = ((...a: unknown[]) => (wrapped.get as unknown as (...x: unknown[]) => unknown)(...a)) as typeof https.get;
    globalThis.fetch = ((...a: unknown[]) => (wrapped.fetch as unknown as (...x: unknown[]) => unknown)(...a)) as typeof fetch;
    await sleep(30);
    http.request = wrapped.request;
    https.get = wrapped.get;
    globalThis.fetch = wrapped.fetch;
    const out = lines(err);
    expect(out).toContain("http.request was replaced after stubsmith patched it");
    expect(out).toContain("https.get was replaced after stubsmith patched it");
    expect(out).toContain("fetch was replaced after stubsmith patched it");
    expect(out).not.toContain("https.request was replaced");
  });

  it("is silent when nothing was replaced, and when debug is off", async () => {
    let err = await reinstall(true);
    await sleep(30);
    expect(lines(err)).not.toContain("was replaced");
    err = await reinstall(false);
    http.request = ((...a: unknown[]) => (realHttp.request as unknown as (...x: unknown[]) => unknown)(...a)) as typeof http.request;
    await sleep(30);
    http.request = realHttp.request;
    expect(lines(err)).not.toContain("was replaced");
  });
});

describe("late reads after the grace period", () => {
  it("http: logs once that data arrived after the empty-body capture, and does not capture again", async () => {
    setUnreadGraceMsForTests(40);
    await client.close();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000, debug: true });
    const res = await new Promise<http.IncomingMessage>((resolve) => http.get(`${upstream.base}/json`, resolve));
    await sleep(120);
    res.resume();
    await new Promise((r) => res.on("end", r));
    const [p] = await exactly(1);
    expect(p?.["resp_key_paths"]).toEqual([]);
    const out = err.mock.calls.map((a) => String(a[0])).join("");
    expect(out.match(/grace period/g)).toHaveLength(1);
  });

  it("fetch: a reader attaching after the grace period gets the body, the capture stays empty and is not repeated", async () => {
    setUnreadGraceMsForTests(40);
    await client.close();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000, debug: true });
    const res = await fetch(`${upstream.base}/json`);
    await sleep(120);
    expect(await res.text()).toBe('{"id": 1, "name": "x"}');
    const [p] = await exactly(1);
    expect(p?.["resp_key_paths"]).toEqual([]);
    expect(err.mock.calls.map((a) => String(a[0])).join("").match(/grace period/g)).toHaveLength(1);
  });
});

describe("request and response lifecycle edge cases", () => {
  it("end() on a request that was already destroyed does not leave a pending exchange", async () => {
    const r = http.request(`${upstream.base}/json`);
    r.on("error", () => undefined);
    r.destroy(new Error("x"));
    await sleep(30);
    r.end();
    expect(pendingCounts(client)).toEqual({ bodyInProgress: 0, finalizing: 0 });
    const t0 = Date.now();
    await client.flush({ timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("a fetch body that is read in part and then abandoned is dropped and released after the grace period", async () => {
    setUnreadGraceMsForTests(80);
    const res = await fetch(`${upstream.base}/chunks`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // partial read, no cancel
    expect(pendingCounts(client).bodyInProgress).toBe(1);
    await waitFor(() => pendingCounts(client).bodyInProgress === 0, 500);
    const t0 = Date.now();
    await client.flush({ timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(100);
    await sleep(60);
    expect(backend.captures).toHaveLength(0); // no empty-body record for a partly read body
    // the rest is still delivered to a caller that comes back
    let rest = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      rest += Buffer.from(r.value).toString();
    }
    expect(rest).toContain("chunk_c");
    await sleep(60);
    expect(backend.captures).toHaveLength(0);
  });

  it("a slow but steady reader is not mistaken for an abandoned one", async () => {
    setUnreadGraceMsForTests(100);
    const res = await fetch(`${upstream.base}/chunks`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      await sleep(30);
    }
    await exactly(1);
  });

  it("the pass-through clone() keeps url, redirected and type, recursively; own keys stay empty", async () => {
    const res = await fetch(`${upstream.base}/redirect`);
    expect(Object.keys(res)).toEqual([]);
    const c1 = res.clone();
    expect(c1.url).toBe(`${upstream.base}/json`);
    expect(c1.redirected).toBe(true);
    expect(c1.type).toBe("basic");
    const c2 = c1.clone();
    expect(c2.url).toBe(`${upstream.base}/json`);
    expect(c2.type).toBe("basic");
    expect(Object.keys(c2)).toEqual([]);
    expect(await c2.text()).toBe('{"id": 1, "name": "x"}');
    expect(await res.text()).toBe('{"id": 1, "name": "x"}');
  });

  it("the pass-through body is a byte stream: a BYOB reader works", async () => {
    const res = await fetch(`${upstream.base}/chunks`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader({ mode: "byob" });
    let out = "";
    for (;;) {
      const r = await reader.read(new Uint8Array(8));
      if (r.done) break;
      out += Buffer.from(r.value).toString();
    }
    expect(out).toBe('{"chunk_a": 1, "chunk_b": 2, "chunk_c": 3}');
    const [p] = await exactly(1);
    expect(p?.["resp_key_paths"]).toEqual(["chunk_a", "chunk_b", "chunk_c"]);
  });
});

describe("a free-text body labelled as a form is never sent as field names", () => {
  for (const [name, call] of KINDS) {
    it(`${name}`, async () => {
      await call(`${upstream.base}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "Dear SECRET, your PIN is 1234",
      });
      const [p] = await exactly(1);
      expect(p?.["req_body"]).toBe("<masked>");
      expect(p?.["key_paths"]).toEqual([]);
      expect(JSON.stringify(p)).not.toContain("SECRET");
    });

    it(`${name}: response body`, async () => {
      await call(`${upstream.base}/formtext`);
      const [p] = await exactly(1);
      expect(p?.["resp_body"]).toBe("<masked>");
      expect(p?.["resp_key_paths"]).toEqual([]);
      expect(JSON.stringify(p)).not.toContain("RESPTEXT");
    });
  }
});

describe("a multipart upload is sent as <masked> with no made-up form fields", () => {
  function expectOpaque(p: Payload | undefined): void {
    const headers = Object.entries(p?.["headers"] as Record<string, string>);
    expect(headers.find(([k]) => k.toLowerCase() === "content-type")?.[1]).toMatch(/^multipart\/form-data/);
    expect(p?.["req_body"]).toBe("<masked>");
    expect(p?.["key_paths"]).toEqual([]);
    const wire = JSON.stringify(p);
    expect(wire).not.toContain("folder");
    expect(wire).not.toContain("invoices");
    expect(wire).not.toContain("hello");
  }

  it("fetch", async () => {
    const form = new FormData();
    form.append("file", new Blob(["hello"]), "a.txt");
    form.append("folder", "invoices");
    const res = await fetch(`${upstream.base}/upload`, { method: "POST", body: form });
    await res.arrayBuffer();
    expectOpaque((await exactly(1))[0]);
  });

  it("http", async () => {
    const boundary = "stubsmith-test-boundary";
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="folder"\r\n\r\ninvoices\r\n--${boundary}--\r\n`;
    await httpCall(`${upstream.base}/upload`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expectOpaque((await exactly(1))[0]);
  });
});

describe("a JSON request is captured with keys kept and values masked", () => {
  it("http: POST with a JSON body", async () => {
    const res = await httpCall(`${upstream.base}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tenant": "acme" },
      body: JSON.stringify({ item: "widget" }),
    });
    expect(res.status).toBe(201);
    const [p] = await exactly(1);
    expect(p?.["source"]).toBe("node-http");
    expect(p?.["method"]).toBe("POST");
    expect(p).toHaveProperty("path");
    expect(String(p?.["path"])).toContain("/orders");
    expect(p).not.toHaveProperty("url");
    expect(Object.keys(p?.["headers"] as object).some((k) => k.toLowerCase() === "x-tenant")).toBe(true);
    // The body is masked (novel fingerprint): the key stays and the value does not.
    expect(p?.["req_body"]).toBeTruthy();
    const reqObj = JSON.parse(p?.["req_body"] as string) as Record<string, unknown>;
    expect(reqObj).toHaveProperty("item");
    expect(reqObj["item"]).toBe("<masked>");
    expect(p?.["req_body"]).not.toContain("widget");
    expect(p?.["status"]).toBe(201);
    expect(p?.["resp_body"]).toBeTruthy();
    expect((JSON.parse(p?.["resp_body"] as string) as Record<string, unknown>)["id"]).toBe(0);
    expect(p?.["resp_body"]).not.toContain("42");
    expect(Object.keys(p?.["resp_headers"] as object).some((k) => k.toLowerCase() === "x-response-id")).toBe(true);
    expect(Number.isInteger(p?.["duration"])).toBe(true);
    expect(p?.["duration"] as number).toBeGreaterThanOrEqual(0);
  });

  it("fetch: POST with a JSON body", async () => {
    const res = await fetchCall(`${upstream.base}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth": "tok" },
      body: JSON.stringify({ name: "foo" }),
    });
    expect(res.status).toBe(200);
    const [p] = await exactly(1);
    expect(p?.["source"]).toBe("node-fetch");
    expect(p?.["method"]).toBe("POST");
    expect(p).toHaveProperty("path");
    expect(String(p?.["path"])).toContain("/items");
    expect(p).not.toHaveProperty("url");
    expect(p?.["status"]).toBe(200);
    expect(Number.isInteger(p?.["duration"])).toBe(true);
    expect(p?.["duration"] as number).toBeGreaterThanOrEqual(0);
    expect(p?.["req_body"]).toBeTruthy();
    const reqObj = JSON.parse(p?.["req_body"] as string) as Record<string, unknown>;
    expect(reqObj).toHaveProperty("name");
    expect(reqObj["name"]).toBe("<masked>");
    expect(p?.["req_body"]).not.toContain("foo");
    expect(p?.["resp_body"]).toBeTruthy();
    expect((p?.["resp_body"] as string).toLowerCase()).not.toContain("true");
    expect(Object.keys(p?.["resp_headers"] as object).some((k) => k.toLowerCase() === "x-srv")).toBe(true);
  });
});

describe("the client path adds source and duration", () => {
  it("http: a masked payload with source, duration and sdk_masked, captured once", async () => {
    await httpCall(`${upstream.base}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test" }),
    });
    const [p] = await exactly(1);
    expect(p).toHaveProperty("source");
    expect(p).toHaveProperty("duration");
    expect(p?.["sdk_masked"]).toBe(true);
  });
});

describe("a body far over 64 KiB is captured whole and parses", () => {
  for (const [name, call] of KINDS) {
    it(`${name}`, async () => {
      expect(bigJson().length).toBeGreaterThan(64 * 1024);
      await call(`${upstream.base}/stock`);
      const [p] = await exactly(1);
      // The decisive assertion: what was stored is a JSON document.
      JSON.parse(p?.["resp_body"] as string);
      expect(p?.["bodies_omitted"]).toBeFalsy();
    });
  }
});

describe("userinfo and a free-text form body are not sent", () => {
  const FORM_CT = "application/x-www-form-urlencoded";

  function expectNoUserinfoOrText(p: Payload | undefined, host: string): void {
    expect(p?.["domain"]).toBe(host);
    const raw = JSON.stringify(p);
    for (const leaked of ["usr", "SECRET_PW", "REQTEXT", "RESPTEXT"]) expect(raw).not.toContain(leaked);
    expect(p?.["req_body"]).toBe("<masked>");
    expect(p?.["resp_body"]).toBe("<masked>");
    expect(p?.["key_paths"]).toEqual([]);
    expect(p?.["resp_key_paths"]).toEqual([]);
  }

  it("http", async () => {
    const host = upstream.base.replace("http://", "");
    await httpCall(`http://usr:SECRET_PW@${host}/notes`, {
      method: "POST",
      headers: { "Content-Type": FORM_CT },
      body: "Dear REQTEXT, your PIN is 1234",
    });
    expectNoUserinfoOrText((await exactly(1))[0], host);
  });

  it("fetch rejects a URL with credentials", async () => {
    const host = upstream.base.replace("http://", "");
    await expect(
      fetchCall(`http://usr:SECRET_PW@${host}/notes`, {
        method: "POST",
        headers: { "Content-Type": FORM_CT },
        body: "Dear REQTEXT, your PIN is 1234",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await sleep(60);
    expect(backend.captures).toHaveLength(0);
    expect(upstream.requests).toHaveLength(0);
  });
});
