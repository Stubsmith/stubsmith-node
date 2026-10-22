import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendRequest } from "../src/transport.js";
import { startUpstream, type Upstream } from "./helpers/servers.js";

let srv: Upstream | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await srv?.close();
  srv = null;
});

const base = { method: "GET", headers: {}, timeoutMs: 5000, maxBytes: 1024 };

describe("process hold", () => {
  /** Count `unref()` calls on sockets and on the 12345 ms deadline timer while one request runs. */
  async function run(holdProcess: boolean): Promise<{ socketUnrefs: number; timerRefd: boolean }> {
    // Sampled when the request reaches the server: later, Node's own keep-alive agent unrefs idle sockets.
    let socketUnrefs = 0;
    let atRequest = 0;
    srv = await startUpstream((_q, res) => {
      atRequest = socketUnrefs;
      res.end("ok");
    });
    const realUnref = net.Socket.prototype.unref;
    vi.spyOn(net.Socket.prototype, "unref").mockImplementation(function (this: net.Socket) {
      socketUnrefs++;
      return realUnref.call(this);
    });
    let deadline: NodeJS.Timeout | null = null;
    const realSet = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = realSet(fn, ms);
      if (ms === 12345) deadline = t;
      return t;
    }) as typeof setTimeout);
    const p = sendRequest(srv.base, { ...base, totalTimeoutMs: 12345, ...(holdProcess ? { holdProcess } : {}) });
    const timerRefd = deadline === null ? false : (deadline as NodeJS.Timeout).hasRef();
    await p.promise;
    return { socketUnrefs: atRequest, timerRefd };
  }

  it("default: socket and deadline timer are unref'd", async () => {
    const r = await run(false);
    expect(r.socketUnrefs).toBeGreaterThan(0);
    expect(r.timerRefd).toBe(false);
  });

  it("holdProcess: neither is unref'd", async () => {
    const r = await run(true);
    expect(r.socketUnrefs).toBe(0);
    expect(r.timerRefd).toBe(true);
  });
});

describe("truncation", () => {
  it("flags a body cut at maxBytes", async () => {
    srv = await startUpstream((_q, res) => res.end("x".repeat(5000)));
    const r = await sendRequest(srv.base, { ...base, maxBytes: 100 }).promise;
    expect(r.truncated).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.body.length).toBe(100);
  });

  it("a body of exactly maxBytes is complete", async () => {
    srv = await startUpstream((_q, res) => res.end("x".repeat(100)));
    const r = await sendRequest(srv.base, { ...base, maxBytes: 100 }).promise;
    expect(r.truncated).toBe(false);
    expect(r.complete).toBe(true);
  });

  it("flags a connection closed before the body ended", async () => {
    srv = await startUpstream((_q, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("abc");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const r = await sendRequest(srv.base, base).promise;
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.body.toString()).toBe("abc");
  });

  it("a normal response is complete", async () => {
    srv = await startUpstream((_q, res) => res.end("hi"));
    const r = await sendRequest(srv.base, base).promise;
    expect(r).toMatchObject({ truncated: false, complete: true });
  });
});

describe("holdProcess deadlines", () => {
  /** Server that sends one byte every 40 ms forever. */
  function trickle(): Promise<Upstream> {
    return startUpstream((_q: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200);
      const t = setInterval(() => res.write("."), 40);
      res.on("close", () => clearInterval(t));
    });
  }

  it("timeoutMs is an idle timeout: a slow but steady transfer outlives it", async () => {
    srv = await startUpstream((_q, res) => {
      res.writeHead(200);
      let n = 0;
      const t = setInterval(() => {
        res.write(".");
        if (++n === 15) {
          clearInterval(t);
          res.end();
        }
      }, 40);
    });
    // 600 ms in total, but never 250 ms without bytes.
    const r = await sendRequest(srv.base, { ...base, timeoutMs: 250, holdProcess: true }).promise;
    expect(r.complete).toBe(true);
    expect(r.body.length).toBe(15);
  });

  it("the total deadline still ends a transfer that never finishes", async () => {
    srv = await trickle();
    await expect(
      sendRequest(srv.base, { ...base, timeoutMs: 5000, totalTimeoutMs: 300, holdProcess: true }).promise,
    ).rejects.toThrow("timeout");
  });

  it("a stalled holdProcess request times out on idle", async () => {
    srv = await startUpstream(() => undefined);
    await expect(sendRequest(srv.base, { ...base, timeoutMs: 200, holdProcess: true }).promise).rejects.toThrow("timeout");
  });

  it("without holdProcess the total deadline is timeoutMs", async () => {
    srv = await trickle();
    await expect(sendRequest(srv.base, { ...base, timeoutMs: 300 }).promise).rejects.toThrow("timeout");
  });
});
