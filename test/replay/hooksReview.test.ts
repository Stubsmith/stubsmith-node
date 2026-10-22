import { getEventListeners } from "node:events";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import axios from "axios";
import superagent from "superagent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayActive } from "../../src/replayState.js";
import { replay } from "../../src/replay/index.js";
import { splitSetCookie } from "../../src/replayHooks.js";
import { sleep } from "../helpers/servers.js";
import { BASE_URL, FP_EMPTY_GET, bundle, endpoint, simpleBundle, stub, variant } from "./helpers.js";

const originals = {
  httpRequest: http.request,
  fetch: globalThis.fetch,
};

beforeEach(() => {
  const refuse = (what: string) => (): never => {
    throw new Error(`network attempted: ${what}`);
  };
  vi.spyOn(net, "connect").mockImplementation(refuse("net.connect"));
  vi.spyOn(net, "createConnection").mockImplementation(refuse("net.createConnection"));
  vi.spyOn(tls, "connect").mockImplementation(refuse("tls.connect"));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(refuse("Socket#connect"));
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(replayActive()).toBe(false);
  expect(http.request).toBe(originals.httpRequest);
  expect(globalThis.fetch).toBe(originals.fetch);
});

const one = (path: string, ...variants: Parameters<typeof variant>[]) =>
  endpoint("GET", path, [stub(FP_EMPTY_GET, variants.map((v) => variant(...v)))]);

describe("destroying a served response", () => {
  it("res.destroy() with no error listener does not throw and emits close", async () => {
    const r = replay({ bundle: simpleBundle() });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => void uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      await new Promise<void>((resolve, reject) => {
        http
          .get(`${BASE_URL}/health`, (res) => {
            res.once("close", resolve);
            res.destroy();
          })
          .on("error", reject);
      });
      await sleep(20);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      r.restore();
    }
  });

  it("axios follows a recorded 302 to a recorded 200", async () => {
    const r = replay({
      bundle: bundle(
        one("/old", [302, "", { headers: { location: `${BASE_URL}/new` } }]),
        one("/new", [200, '{"moved": true}']),
      ),
    });
    try {
      const res = await axios.get(`${BASE_URL}/old`);
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ moved: true });
      expect(r.served().map((s) => s.status)).toEqual([302, 200]);
    } finally {
      r.restore();
    }
  });
});

describe("set-cookie", () => {
  const COOKIES = "a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/, b=2; Secure";
  const cookieBundle = bundle(one("/c", [200, "{}", { headers: { "set-cookie": COOKIES } }]));

  it("is an array on res.headers while rawHeaders keep the recorded value", async () => {
    const r = replay({ bundle: cookieBundle });
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get(`${BASE_URL}/c`, resolve).on("error", reject);
      });
      res.resume();
      expect(res.headers["set-cookie"]).toEqual(["a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/", "b=2; Secure"]);
      expect(res.rawHeaders).toEqual(["set-cookie", COOKIES]);
    } finally {
      r.restore();
    }
  });

  it("splitSetCookie splits on a comma before a name= token only", () => {
    expect(splitSetCookie(COOKIES)).toEqual(["a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/", "b=2; Secure"]);
    expect(splitSetCookie("a=1")).toEqual(["a=1"]);
    expect(splitSetCookie("a=1,b=2,  c=3")).toEqual(["a=1", "b=2", "c=3"]);
    expect(splitSetCookie("a=x, y; Path=/")).toEqual(["a=x, y; Path=/"]);
    expect(splitSetCookie("")).toEqual([""]);
  });
});

describe("fetch", () => {
  const ok = bundle(one("/slow", [200, '"ok"']));

  it("rejects when the signal is aborted right after the call", async () => {
    const r = replay({ bundle: ok });
    try {
      const ac = new AbortController();
      const p = fetch(`${BASE_URL}/slow`, { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      expect(r.served()).toEqual([]);
    } finally {
      r.restore();
    }
  });

  it("rejects with the TimeoutError reason of an AbortSignal.timeout signal", async () => {
    const r = replay({ bundle: ok });
    try {
      const signal = AbortSignal.timeout(1);
      await sleep(20);
      await expect(fetch(`${BASE_URL}/slow`, { signal })).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      r.restore();
    }
  });

  it("passes data: URLs through to the real fetch", async () => {
    const r = replay({ bundle: ok });
    try {
      const res = await fetch("data:text/plain,hi");
      expect(await res.text()).toBe("hi");
      expect(r.served()).toEqual([]);
    } finally {
      r.restore();
    }
  });
});

describe("abort listeners on http requests", () => {
  it("20 requests sharing one signal leave no listener behind", async () => {
    const r = replay({ bundle: simpleBundle() });
    try {
      const ac = new AbortController();
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve, reject) => {
          http
            .get(`${BASE_URL}/health`, { signal: ac.signal }, (res) => {
              res.resume();
              res.once("close", resolve);
            })
            .on("error", reject);
        });
      }
      await sleep(10);
      expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
    } finally {
      r.restore();
    }
  });
});

describe("superagent", () => {
  it("GET parses a recorded JSON response", async () => {
    const r = replay({ bundle: simpleBundle() });
    try {
      const res = await superagent.get(`${BASE_URL}/users/42`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 42, name: "Ada" });
      expect(res.headers["x-served"]).toBe("replay");
    } finally {
      r.restore();
    }
  });
});

describe("nested restore order", () => {
  it("a then b restored in creation order ends on the original functions", () => {
    const a = replay({ bundle: simpleBundle() });
    const b = replay({ bundle: simpleBundle() });
    a.restore();
    b.restore();
    // afterEach asserts http.request and fetch are the originals
    expect(replayActive()).toBe(false);
  });
});
