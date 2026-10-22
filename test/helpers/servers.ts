import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

/** Poll `fn` until it returns truthy or the timeout elapses; resolves the last value. */
export async function waitFor<T>(fn: () => T, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = fn();
  while (!v && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    v = fn();
  }
  return v;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  /** Decoded (gunzipped when needed) JSON body, or null when not JSON. */
  json: Record<string, unknown> | null;
}

export interface FakeBackend {
  base: string;
  /** Ingest endpoint, `${base}/v1/captures`. */
  ingestUrl: string;
  captures: Received[];
  syncRequests: Received[];
  otherRequests: Received[];
  /** Ingest answer; default 201 `{ok:true}`. `delayMs` holds the response. */
  ingest: { status: number; body: string; delayMs: number };
  /** Sync answer; default 500 so no first sync happens until a test sets it. */
  sync: { status: number; body: string; delayMs: number };
  /** Legacy rules answer. */
  legacy: { status: number; body: string };
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

/** A local ingest + sync server. No network beyond 127.0.0.1. */
export async function startBackend(): Promise<FakeBackend> {
  const state = {
    captures: [] as Received[],
    syncRequests: [] as Received[],
    otherRequests: [] as Received[],
    ingest: { status: 201, body: '{"ok": true, "id": "x"}', delayMs: 0 },
    sync: { status: 500, body: "boom", delayMs: 0 },
    legacy: { status: 404, body: "" },
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const rec: Received = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw, json: null };
      const answer = (s: { status: number; body: string }): void => {
        res.writeHead(s.status, { "content-type": "application/json" });
        res.end(s.body);
      };
      if (req.method === "POST" && req.url === "/v1/captures") {
        try {
          const buf = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
          rec.json = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        } catch {
          rec.json = null;
        }
        state.captures.push(rec);
        if (state.ingest.delayMs) await sleep(state.ingest.delayMs);
        answer(state.ingest);
      } else if (req.url?.startsWith("/v1/sdk/sync")) {
        state.syncRequests.push(rec);
        if (state.sync.delayMs) await sleep(state.sync.delayMs);
        answer(state.sync);
      } else if (req.url === "/v1/anonymizer/rules") {
        state.otherRequests.push(rec);
        answer(state.legacy);
      } else {
        state.otherRequests.push(rec);
        res.writeHead(404);
        res.end();
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  // The server handler reads `state`, so the returned object must be `state` itself.
  return Object.assign(state, {
    base,
    ingestUrl: `${base}/v1/captures`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
}

export interface Upstream {
  base: string;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }>;
  close(): Promise<void>;
}

/** A local upstream API under test; `handler` answers every request. */
export async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<Upstream> {
  const requests: Upstream["requests"] = [];
  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The sync body for one rule that keeps nothing (all masked) so `novel` becomes false. */
export function syncBody(cursor: string, rules: Array<{ domain: string; method: string; path_template: string; fingerprint: string }>): string {
  return JSON.stringify({
    ok: true,
    cursor,
    rules: rules.map((r, i) => ({
      seq: i + 1,
      request_type: { domain: r.domain, method: r.method, path_template: r.path_template },
      fingerprint: r.fingerprint,
      field_rules: [],
    })),
    path_templates: [],
    project_defaults: {},
    request_type_value_config: {},
  });
}
