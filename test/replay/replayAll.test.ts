/* eslint-disable @typescript-eslint/no-unused-vars -- `for await (const _ of replayAll())` drives passes without needing the context */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { replayActive } from "../../src/replayState.js";
import { StubNotFound, replay, replayAll, byStatus } from "../../src/replay/index.js";
import { BASE_URL, DOMAIN, FP_EMPTY_GET, bundle, endpoint, sample, stub, variant, windowed } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  expect(replayActive()).toBe(false);
  expect(globalThis.fetch).toBe(realFetch);
});

function windowedBundle() {
  return bundle(
    endpoint("GET", "/orders", [
      stub(FP_EMPTY_GET, [
        windowed(200, 90, [sample("c200a", '{"n": 1}'), sample("c200b", '{"n": 2}'), sample("c200c", '{"n": 3}')]),
        windowed(429, 2, [sample("c429a", '{"e": "rate"}')]),
        windowed(500, 1, [sample("c500a", '{"e": "boom"}')]),
      ]),
    ]),
  );
}

const getOrders = (): Promise<Response> => fetch(`${BASE_URL}/orders`);

describe("replayAll", () => {
  it("loops every recording once, in order, and the context reports what each pass served", async () => {
    const seen: Array<[number, string, string | null, number]> = [];
    for await (const pass of replayAll({ bundle: windowedBundle() })) {
      const res = await getOrders();
      const served = pass.served();
      expect(served).toHaveLength(1);
      seen.push([res.status, await res.text(), served[0]?.captureId ?? null, pass.passNumber]);
    }
    expect(seen).toEqual([
      [200, '{"n": 1}', "c200a", 1],
      [200, '{"n": 2}', "c200b", 2],
      [200, '{"n": 3}', "c200c", 3],
      [429, '{"e": "rate"}', "c429a", 4],
      [500, '{"e": "boom"}', "c500a", 5],
    ]);
  });

  it("pass one matches plain replay()", async () => {
    const b = windowedBundle();
    const plain = replay({ bundle: b });
    const baseline = await getOrders();
    const baselineText = await baseline.text();
    plain.restore();
    for await (const _ of replayAll({ bundle: b })) {
      const got = await getOrders();
      expect([got.status, await got.text()]).toEqual([baseline.status, baselineText]);
      break;
    }
  });

  it("exposes a 0-based passIndex alongside the 1-based passNumber", async () => {
    const idx: number[] = [];
    for await (const pass of replayAll({ bundle: windowedBundle() })) {
      await getOrders();
      idx.push(pass.passIndex);
      expect(pass.passNumber).toBe(pass.passIndex + 1);
    }
    expect(idx).toEqual([0, 1, 2, 3, 4]);
  });

  it("a bundle without samples yields one pass per status", async () => {
    const b = bundle(endpoint("GET", "/orders", [stub(FP_EMPTY_GET, [variant(200, '{"a": 1}', { count: 5 }), variant(500, '{"b": 2}')])]));
    const codes: number[] = [];
    for await (const _ of replayAll({ bundle: b })) codes.push((await getOrders()).status);
    expect(codes).toEqual([200, 500]);
  });

  it("a single recording yields exactly one pass", async () => {
    const b = bundle(endpoint("GET", "/orders", [stub(FP_EMPTY_GET, [variant(200, "1")])]));
    let passes = 0;
    for await (const _ of replayAll({ bundle: b })) {
      await getOrders();
      passes++;
    }
    expect(passes).toBe(1);
  });

  it("a short window clamps instead of throwing, and flags the clamped shape as exhausted", async () => {
    const b = bundle(
      endpoint("GET", "/orders", [stub(FP_EMPTY_GET, [windowed(200, 3, [sample("l-a", '{"i": 1}'), sample("l-b", '{"i": 2}'), sample("l-c", '{"i": 3}')])])]),
      endpoint("GET", "/health", [stub(FP_EMPTY_GET, [windowed(200, 1, [sample("s-a", '{"ok": true}')])])]),
    );
    const orders: string[] = [];
    const health: string[] = [];
    for await (const pass of replayAll({ bundle: b })) {
      orders.push(await (await getOrders()).text());
      health.push(await (await fetch(`${BASE_URL}/health`)).text());
      const byEp = new Map(pass.served().map((s) => [s.pathTemplate, s]));
      if (pass.passNumber > 1) expect(byEp.get("/health")?.exhausted).toBe(true);
      expect(byEp.get("/orders")?.index).toBe(pass.passIndex);
    }
    expect(orders).toEqual(['{"i": 1}', '{"i": 2}', '{"i": 3}']);
    expect(health).toEqual(Array(3).fill('{"ok": true}'));
  });

  it("an endpoint first reached on a later pass is still looped from its first recording", async () => {
    const b = bundle(
      endpoint("GET", "/orders", [
        stub(FP_EMPTY_GET, [windowed(200, 5, [sample("ok-a", '{"ok": true}')]), windowed(500, 1, [sample("err-a", '{"err": true}')])]),
      ]),
      endpoint("GET", "/retry", [
        stub(FP_EMPTY_GET, [windowed(200, 2, [sample("r-a", '{"r": 1}'), sample("r-b", '{"r": 2}'), sample("r-c", '{"r": 3}')])]),
      ]),
    );
    const retries: string[] = [];
    let passes = 0;
    for await (const _ of replayAll({ bundle: b })) {
      // /retry is only reached after a 500, so pass one never touches it.
      if ((await getOrders()).status >= 500) retries.push(await (await fetch(`${BASE_URL}/retry`)).text());
      passes++;
    }
    expect(retries).toEqual(['{"r": 1}', '{"r": 2}', '{"r": 3}']);
    expect(passes).toBe(4);
  });

  it("a shape called twice in one pass serves the same recording both times", async () => {
    for await (const pass of replayAll({ bundle: windowedBundle(), maxPasses: 2 })) {
      const a = await (await getOrders()).text();
      const b = await (await getOrders()).text();
      expect(a).toBe(b);
      expect(pass.served().map((s) => s.index)).toEqual([pass.passIndex, pass.passIndex]);
    }
  });

  it("maxPasses caps the loop", async () => {
    let passes = 0;
    for await (const _ of replayAll({ bundle: windowedBundle(), maxPasses: 2 })) {
      await getOrders();
      passes++;
    }
    expect(passes).toBe(2);
  });

  it("maxPasses must be a positive integer, reported before the first iteration", () => {
    expect(() => replayAll({ bundle: windowedBundle(), maxPasses: 0 })).toThrow(RangeError);
    expect(() => replayAll({ bundle: windowedBundle(), maxPasses: 1.5 })).toThrow(/maxPasses/);
  });

  it("hooks are installed only for the body of each pass and restored between and after", async () => {
    const seenActive: boolean[] = [];
    for await (const pass of replayAll({ bundle: windowedBundle(), maxPasses: 2 })) {
      seenActive.push(replayActive(), pass.active);
      expect(globalThis.fetch).not.toBe(realFetch);
      await getOrders();
    }
    expect(seenActive).toEqual([true, true, true, true]);
  });

  it("break and a throwing body restore the hooks", async () => {
    for await (const _ of replayAll({ bundle: windowedBundle() })) break;
    expect(globalThis.fetch).toBe(realFetch);
    await expect(
      (async () => {
        for await (const _ of replayAll({ bundle: windowedBundle() })) throw new Error("body failed");
      })(),
    ).rejects.toThrow("body failed");
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("works through http.get as well as fetch", async () => {
    const codes: number[] = [];
    for await (const _ of replayAll({ bundle: windowedBundle() })) {
      codes.push(
        await new Promise<number>((resolve, reject) => {
          http
            .get(`http://${DOMAIN}/orders`, (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            })
            .on("error", reject);
        }),
      );
    }
    expect(codes).toEqual([200, 200, 200, 429, 500]);
  });
});

describe("replayAll statuses filter", () => {
  it("loops only the requested status", async () => {
    const got: number[] = [];
    for await (const _ of replayAll({ bundle: windowedBundle(), statuses: [200] })) got.push((await getOrders()).status);
    expect(got).toEqual([200, 200, 200]);
  });

  it("a set of statuses loops all of them, and any iterable is accepted", async () => {
    const got: number[] = [];
    for await (const _ of replayAll({ bundle: windowedBundle(), statuses: new Set([429, 500]) })) got.push((await getOrders()).status);
    expect(got).toEqual([429, 500]);
  });

  it("index and total describe the filtered window, and the filter bounds the pass count", async () => {
    let passes = 0;
    for await (const pass of replayAll({ bundle: windowedBundle(), statuses: [500] })) {
      await getOrders();
      expect(pass.served()[0]).toMatchObject({ index: 0, total: 1, status: 500 });
      passes++;
    }
    expect(passes).toBe(1);
  });

  it("a status with no recording throws StubNotFound instead of substituting, and restores the hooks", async () => {
    let err: unknown;
    try {
      for await (const _ of replayAll({ bundle: windowedBundle(), statuses: [503] })) await getOrders();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StubNotFound);
    expect((err as StubNotFound).message).toContain("no recorded 503 response for GET /orders");
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("one endpoint missing the status does not hide behind another that has it", async () => {
    const b = bundle(
      endpoint("GET", "/orders", [stub(FP_EMPTY_GET, [variant(500, "1")])]),
      endpoint("GET", "/health", [stub(FP_EMPTY_GET, [variant(200, "1")])]),
    );
    let seen = 0;
    await expect(
      (async () => {
        for await (const _ of replayAll({ bundle: b, statuses: [200] })) {
          seen++;
          await fetch(`${BASE_URL}/health`);
          await getOrders();
        }
      })(),
    ).rejects.toBeInstanceOf(StubNotFound);
    expect(seen).toBe(1);
  });
});

describe("select", () => {
  it("byStatus through replay() serves that status", async () => {
    const r = replay({ bundle: windowedBundle(), select: byStatus(429) });
    try {
      expect((await getOrders()).status).toBe(429);
    } finally {
      r.restore();
    }
  });

  it("byStatus for an unrecorded status rejects with StubNotFound", async () => {
    const r = replay({ bundle: windowedBundle(), select: byStatus(418) });
    try {
      await expect(getOrders()).rejects.toBeInstanceOf(StubNotFound);
    } finally {
      r.restore();
    }
  });

  it("served() reports what ran, in call order", async () => {
    const b = bundle(
      endpoint("GET", "/a", [stub(FP_EMPTY_GET, [variant(200, "1")])]),
      endpoint("GET", "/b/{id}", [stub(FP_EMPTY_GET, [variant(404, "1")])]),
    );
    const r = replay({ bundle: b });
    try {
      await fetch(`${BASE_URL}/a`);
      await fetch(`${BASE_URL}/b/9`);
      await fetch(`${BASE_URL}/a`);
      expect(r.served().map((s) => `${s.status} ${s.pathTemplate}`)).toEqual(["200 /a", "404 /b/{id}", "200 /a"]);
    } finally {
      r.restore();
    }
  });
});
