/* eslint-disable @typescript-eslint/no-unused-vars -- `for await (const _ of replayAll())` drives passes without needing the context */
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { afterEach, describe, expect, it } from "vitest";
import { StubNotFound, byStatus, replay, replayAll } from "../../src/replay/index.js";
import type { ReplayContext, ReplayOptions } from "../../src/replay/index.js";

const SAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-bundle.json");
const BASE = "http://localhost:8081";

let ctx: ReplayContext | undefined;
afterEach(() => {
  ctx?.restore();
  ctx = undefined;
});
const start = (select?: ReplayOptions["select"]): ReplayContext =>
  (ctx = replay({ bundle: SAMPLE, select }));

const json = (method: string, p: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${p}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the real sample bundle", () => {
  it("loads from a path and exposes it on the context", () => {
    start();
    expect(ctx?.bundlePath).toBe(SAMPLE);
  });

  it("GET with query names only: values do not matter", async () => {
    start();
    const res = await fetch(`${BASE}/api/orders?status=pending&limit=500`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-length")).toBeNull(); // hop-by-hop, stripped
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(2);
  });

  it("a templated id path serves the matching endpoint when fingerprints collide across endpoints", async () => {
    start();
    expect(await (await fetch(`${BASE}/api/orders/77`)).json()).toMatchObject({ order_id: 5234 });
    expect(await (await fetch(`${BASE}/api/users/42`)).json()).toMatchObject({ id: 4821 });
  });

  it("two statuses on one stub: the default is the lowest status on a count tie, byStatus reaches the other", async () => {
    start();
    expect((await fetch(`${BASE}/api/users/42`)).status).toBe(200);
    ctx?.restore();
    start(byStatus(404));
    const res = await fetch(`${BASE}/api/users/42`);
    expect(res.status).toBe(404);
    expect(res.statusText).toBe("Not Found");
  });

  it("distinct request shapes of one endpoint select their own recording (402 vs 201 charges)", async () => {
    start();
    const card = { number: "x", exp_month: 1, exp_year: 2, cvc: "1", holder: "h" };
    const customer = { email: "a", name: "n", phone: "p" };
    const declined = await json("POST", "/api/payments/charges", { amount_cents: 1, currency: "eur", card, customer });
    expect(declined.status).toBe(402);
    const ok = await json("POST", "/api/payments/charges", { amount_cents: 1, currency: "eur", card, customer, idempotency_key: "k" });
    expect(ok.status).toBe(201);
  });

  it("a request with an unrecorded shape misses with a near-miss diff against the closest recording", async () => {
    start();
    const err = await json("POST", "/api/auth/login", { email: "a", password: "b", remember_me: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StubNotFound);
    const msg = (err as StubNotFound).message;
    expect(msg).toContain("+ remember_me");
    expect(msg).toContain("Closest recording  88a4c74a696c6e89");
    expect(msg).toContain(`[bundle loaded from: ${SAMPLE}]`);
  });

  it("works through axios", async () => {
    start();
    const res = await axios.post(`${BASE}/api/auth/login`, { email: "a", password: "b" });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("expires_in", 7200);
  });

  it("replayAll over the sample yields a pass per status of the stub it touches", async () => {
    const statuses: number[] = [];
    for await (const _ of replayAll({ bundle: SAMPLE })) statuses.push((await axios.get(`${BASE}/api/users/1`, { validateStatus: () => true })).status);
    expect(statuses).toEqual([200, 404]);
  });
});
