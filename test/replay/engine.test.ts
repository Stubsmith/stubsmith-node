import { describe, expect, it } from "vitest";
import { PassState, ReplayEngine, ServedResponse, StubNotFound, byStatus, flattenResponses } from "../../src/replay/engine.js";
import type { ReplayRequest } from "../../src/replay/engine.js";
import { DOMAIN, FP_EMPTY_GET, bundle, endpoint, fp, sample, stub, variant, windowed } from "./helpers.js";

const get = (path: string, o: Partial<ReplayRequest> = {}): ReplayRequest => ({ method: "GET", url: `https://${DOMAIN}${path}`, ...o });
const post = (path: string, body: string, ct = "application/json"): ReplayRequest => ({
  method: "POST",
  url: `https://${DOMAIN}${path}`,
  headers: { "Content-Type": ct },
  body,
});
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function missOf(e: ReplayEngine, r: ReplayRequest): StubNotFound {
  try {
    e.serve(r);
  } catch (err) {
    expect(err).toBeInstanceOf(StubNotFound);
    return err as StubNotFound;
  }
  throw new Error("expected a miss");
}

describe("round trip", () => {
  it("serves status, reason phrase, headers, body and duration", () => {
    const e = new ReplayEngine(
      bundle(endpoint("GET", "/ping", [stub(FP_EMPTY_GET, [variant(404, '{"error": "x"}', { duration_ms: 17, headers: { "x-a": "1" } })])])),
    );
    const r = e.serve(get("/ping"));
    expect(r.status).toBe(404);
    expect(r.statusText).toBe("Not Found");
    expect(r.headers).toEqual({ "x-a": "1" });
    expect(text(r.body)).toBe('{"error": "x"}');
    expect(r.durationMs).toBe(17);
  });

  it("a missing duration is zero and a null body is empty", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/p", [stub(FP_EMPTY_GET, [variant(200, null, { duration_ms: null })])])));
    const r = e.serve(get("/p"));
    expect(r.durationMs).toBe(0);
    expect(r.body).toHaveLength(0);
  });

  it("matches the method case-insensitively and keeps the port in the domain", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/p", [stub(FP_EMPTY_GET, [variant(200, "1")])], { domain: "localhost:8081" })));
    expect(e.serve({ method: "get", url: "http://localhost:8081/p" }).status).toBe(200);
    expect(missOf(e, { method: "get", url: "http://localhost:9999/p" }).message).toContain("No traffic has been recorded for GET localhost:9999.");
  });

  it("drops URL userinfo from the domain, as captures do", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/p", [stub(FP_EMPTY_GET, [variant(200, "1")])], { domain: "localhost:8081" })));
    expect(e.serve({ method: "get", url: "http://usr:pw@localhost:8081/p" }).status).toBe(200);
  });

  it("an endpoint stored with a lower-case method is indexed upper-case", () => {
    const e = new ReplayEngine(bundle(endpoint("get", "/p", [stub(FP_EMPTY_GET, [variant(200, "1")])])));
    expect(e.serve(get("/p")).status).toBe(200);
  });
});

describe("path templating", () => {
  const b = bundle(
    endpoint("GET", "/users/{id}", [stub(FP_EMPTY_GET, [variant(200, '"user"')])]),
    endpoint("GET", "/v1/{tenant}/orders", [stub(FP_EMPTY_GET, [variant(200, '"orders"')])]),
  );

  it("a numeric segment matches the bundle's {id} template", () => {
    expect(text(new ReplayEngine(b).serve(get("/users/42")).body)).toBe('"user"');
  });

  it("a curated non-id wildcard matches a literal segment the heuristic would leave alone", () => {
    expect(text(new ReplayEngine(b).serve(get("/v1/acme/orders")).body)).toBe('"orders"');
  });

  it("falls back to the heuristic when no template of this method and domain fits (uuid, long hex)", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/items/{id}", [stub(FP_EMPTY_GET, [variant(200, '"item"')])])));
    expect(e.serve(get("/items/123e4567-e89b-12d3-a456-426614174000")).status).toBe(200);
    expect(e.serve(get("/items/0123456789abcdef")).status).toBe(200);
    // A segment-count mismatch leaves the curated set, so the heuristic alone decides.
    expect(missOf(e, get("/other/123")).pathTemplate).toBe("/other/{id}");
    expect(missOf(e, get("/items/7/more")).pathTemplate).toBe("/items/{id}/more");
    // A curated wildcard matches any literal segment, id-shaped or not.
    expect(e.serve(get("/items/short")).status).toBe(200);
  });

  it("templates are scoped to (method, domain)", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/v1/{tenant}/orders", [stub(FP_EMPTY_GET, [variant(200, "1")])])));
    // POST has no curated template, so the literal path stays literal.
    expect(missOf(e, post("/v1/acme/orders", "")).pathTemplate).toBe("/v1/acme/orders");
    // Another domain does not see this domain's template either.
    expect(missOf(e, { method: "GET", url: "https://other.example.org/v1/acme/orders" }).pathTemplate).toBe("/v1/acme/orders");
  });
});

describe("fingerprinting", () => {
  it("the query string takes part: a stub recorded without params does not match a request with them", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/list", [stub(FP_EMPTY_GET, [variant(200, "[]")])])));
    expect(e.serve(get("/list")).status).toBe(200);
    expect(missOf(e, get("/list?page=2")).fingerprint).toBe(fp("", "page=2", ""));
  });

  it("matches on query names, not values", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/list", [stub(fp("", "page=1", ""), [variant(200, "[]")])])));
    expect(e.serve(get("/list?page=99")).status).toBe(200);
  });

  it("reads the content type from headers case-insensitively, and joins array values", () => {
    const body = "a=1&b=2";
    const e = new ReplayEngine(
      bundle(endpoint("POST", "/f", [stub(fp(body, "", "application/x-www-form-urlencoded"), [variant(200, "1")])])),
    );
    expect(e.serve({ method: "POST", url: `https://${DOMAIN}/f`, headers: { "CONTENT-TYPE": "application/x-www-form-urlencoded; charset=utf-8" }, body }).status).toBe(200);
    expect(e.serve({ method: "POST", url: `https://${DOMAIN}/f`, headers: { "content-type": ["application/x-www-form-urlencoded"] }, body }).status).toBe(200);
  });

  it("decodes a Uint8Array body as UTF-8 and treats an undecodable one as empty", () => {
    const e = new ReplayEngine(
      bundle(
        endpoint("POST", "/j", [
          stub(fp('{"k": "é"}', "", "application/json"), [variant(200, '"json"')]),
          stub(fp("", "", "application/json"), [variant(200, '"empty"')]),
        ]),
      ),
    );
    const r = (body: Uint8Array): ReplayRequest => ({ method: "POST", url: `https://${DOMAIN}/j`, headers: { "content-type": "application/json" }, body });
    expect(text(e.serve(r(new TextEncoder().encode('{"k": "é"}'))).body)).toBe('"json"');
    expect(text(e.serve(r(new Uint8Array([0x7b, 0xff, 0xfe]))).body)).toBe('"empty"');
  });

  it("fingerprint_value_paths of the endpoint discriminate requests by value", () => {
    const vp = ["action"];
    const e = new ReplayEngine(
      bundle(
        endpoint(
          "POST",
          "/v1/charges",
          [
            stub(fp('{"action": "charge"}', "", "application/json", vp), [variant(200, '"charged"')], { key_paths: ["action"] }),
            stub(fp('{"action": "refund"}', "", "application/json", vp), [variant(200, '"refunded"')], { key_paths: ["action"] }),
          ],
          { fingerprint_value_paths: vp },
        ),
      ),
    );
    expect(text(e.serve(post("/v1/charges", '{"action": "refund"}')).body)).toBe('"refunded"');
    expect(text(e.serve(post("/v1/charges", '{"action": "charge"}')).body)).toBe('"charged"');
    const miss = missOf(e, post("/v1/charges", '{"action": "void"}'));
    expect(miss.message).toContain("does not record");
    expect(miss.message).not.toContain("symmetry bug");
  });
});

describe("composite lookup key", () => {
  it("two endpoints that share a fingerprint each serve their own body", () => {
    const e = new ReplayEngine(
      bundle(
        endpoint("GET", "/api/products", [stub(FP_EMPTY_GET, [variant(200, '"products"')])]),
        endpoint("GET", "/api/users/{id}", [stub(FP_EMPTY_GET, [variant(200, '"user"')])]),
        endpoint("GET", "/api/users/{id}", [stub(FP_EMPTY_GET, [variant(200, '"other host"')])], { domain: "other.example.org" }),
      ),
    );
    expect(text(e.serve(get("/api/products")).body)).toBe('"products"');
    expect(text(e.serve(get("/api/users/7")).body)).toBe('"user"');
    expect(text(e.serve({ method: "GET", url: "https://other.example.org/api/users/7" }).body)).toBe('"other host"');
  });
});

describe("variant selection and response ordering", () => {
  const order = (variants: Parameters<typeof flattenResponses>[0]): number[] => flattenResponses(variants).map((r) => r.status);

  it("the highest count wins", () => {
    expect(order([variant(500, "x", { count: 1 }), variant(200, "x", { count: 9 })])).toEqual([200, 500]);
  });
  it("ties are broken by the lowest status, the rest follow by status", () => {
    expect(order([variant(500, "x", { count: 3 }), variant(404, "x", { count: 3 }), variant(200, "x", { count: 1 })])).toEqual([404, 200, 500]);
  });
  it("a single variant, and no variants", () => {
    expect(order([variant(201, "x")])).toEqual([201]);
    expect(flattenResponses([])).toEqual([]);
  });
  it("samples stay newest first inside the primary variant, which leads", () => {
    const r = flattenResponses([
      windowed(500, 1, [sample("e1", "5")]),
      windowed(200, 9, [sample("n3", "3"), sample("n2", "2"), sample("n1", "1")]),
    ]);
    expect(r.map((x) => x.captureId)).toEqual(["n3", "n2", "n1", "e1"]);
  });
  it("a sample falls back to the variant headers when its own are empty, and its own body_encoding wins", () => {
    const v = windowed(200, 1, [sample("a", "QQ==", { headers: {}, body_encoding: "base64" }), sample("b", "QQ==")]);
    v.headers = { "x-v": "1" };
    v.body_encoding = "base64";
    const [a, b] = flattenResponses([v]);
    expect(a?.headers).toEqual({ "x-v": "1" });
    expect(a?.bodyEncoding).toBe("base64");
    expect(b?.headers).toEqual({ "content-type": "application/json" });
    const w = windowed(200, 1, [sample("c", "QQ==", { body_encoding: null })]);
    w.body_encoding = "base64";
    expect(flattenResponses([w])[0]?.bodyEncoding).toBeNull();
  });
  it("a degraded stub with no variants misses", () => {
    const e = new ReplayEngine(bundle(endpoint("GET", "/d", [stub(FP_EMPTY_GET, [], { degraded: true })])));
    expect(missOf(e, get("/d")).message).toContain("no recorded stub for GET /d");
  });
});

describe("select and byStatus", () => {
  const b = bundle(
    endpoint("GET", "/o", [
      stub(FP_EMPTY_GET, [
        windowed(200, 90, [sample("a", '{"n": 1}'), sample("b", '{"n": 2}')]),
        windowed(429, 2, [sample("r", '{"e": "rate"}')]),
      ]),
    ]),
  );

  it("the default serves the first: newest of the most frequent status", () => {
    const e = new ReplayEngine(b);
    expect(text(e.serve(get("/o")).body)).toBe('{"n": 1}');
    expect(e.served()[0]).toMatchObject({ captureId: "a", index: 0, total: 3 });
  });

  it("byStatus serves the newest recording of that status", () => {
    const e = new ReplayEngine(b, { select: byStatus(429) });
    expect(e.serve(get("/o")).status).toBe(429);
  });

  it("byStatus for an unrecorded status throws and lists what is recorded, rather than serving another", () => {
    const e = new ReplayEngine(b, { select: byStatus(503) });
    const miss = missOf(e, get("/o"));
    expect(miss.message).toContain("statuses recorded for this shape: 200, 429");
    expect(e.served()).toEqual([]);
  });

  it("a custom select sees every recording and its pick is reported with its index", () => {
    let seen: number[] = [];
    const e = new ReplayEngine(b, {
      select: (rs) => {
        seen = rs.map((r) => r.status);
        return rs[1];
      },
    });
    expect(text(e.serve(get("/o")).body)).toBe('{"n": 2}');
    expect(seen).toEqual([200, 200, 429]);
    const s = e.served()[0] as ServedResponse;
    expect([s.index, s.total, s.exhausted, s.endpoint]).toEqual([1, 3, false, `GET ${DOMAIN}/o`]);
  });

  it("served() reports one entry per call, as a copy", () => {
    const e = new ReplayEngine(b);
    e.serve(get("/o"));
    e.serve(get("/o"));
    const list = e.served();
    expect(list).toHaveLength(2);
    list.pop();
    expect(e.served()).toHaveLength(2);
  });
});

describe("served response body and headers", () => {
  const one = (v: ReturnType<typeof variant>): ReturnType<ReplayEngine["serve"]> =>
    new ReplayEngine(bundle(endpoint("GET", "/p", [stub(FP_EMPTY_GET, [v])]))).serve(get("/p"));

  it("strips hop-by-hop headers case-insensitively and keeps the others", () => {
    const r = one(
      variant(200, "{}", {
        headers: {
          "Content-Length": "999",
          "Transfer-Encoding": "chunked",
          Connection: "keep-alive",
          "Content-Encoding": "gzip",
          "Keep-Alive": "timeout=5",
          "Proxy-Authenticate": "x",
          "Proxy-Authorization": "x",
          TE: "trailers",
          Trailers: "x",
          Upgrade: "h2c",
          "Content-Type": "application/json",
          "X-Request-Id": "abc",
        },
      }),
    );
    expect(r.headers).toEqual({ "Content-Type": "application/json", "X-Request-Id": "abc" });
  });

  it("decodes a base64 body to the original bytes", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    expect(Buffer.from(one(variant(200, png.toString("base64"), { body_encoding: "base64" })).body)).toEqual(png);
  });
  it("serves a body without an encoding verbatim", () => {
    expect(text(one(variant(200, "QQ==")).body)).toBe("QQ==");
  });
  it("falls back to the literal text for an undecodable base64 body (bad alphabet, bad padding, whitespace)", () => {
    for (const bad of ["not base64!", "QQ=", "QQ==QQ==", "QQ==\n", "Q"]) {
      expect(text(one(variant(200, bad, { body_encoding: "base64" })).body)).toBe(bad);
    }
  });
  it("accepts unpadded-free valid base64 forms", () => {
    expect(text(one(variant(200, "QUI=", { body_encoding: "base64" })).body)).toBe("AB");
    expect(text(one(variant(200, "QUJD", { body_encoding: "base64" })).body)).toBe("ABC");
  });
  it("an unknown encoding is served verbatim", () => {
    expect(text(one(variant(200, "QQ==", { body_encoding: "rot13" })).body)).toBe("QQ==");
  });
  it("an empty base64 body is empty", () => {
    expect(one(variant(200, "", { body_encoding: "base64" })).body).toHaveLength(0);
  });
  it("serialises an object body in the Python json.dumps layout", () => {
    const r = one(variant(200, { b: [1, 2.5, null, true], a: "é" }));
    expect(text(r.body)).toBe('{"b": [1, 2.5, null, true], "a": "\\u00e9"}');
  });
  it("an empty object or array body is empty, like Python falsiness", () => {
    expect(one(variant(200, {})).body).toHaveLength(0);
    expect(one(variant(200, [])).body).toHaveLength(0);
  });
});

describe("near-miss diagnostics", () => {
  const charges = (rec: string, keyPaths: string[], extra: Record<string, unknown> = {}, ct = "application/json"): ReplayEngine =>
    new ReplayEngine(
      bundle(endpoint("POST", "/v1/charges", [stub(fp(rec, "", ct), [variant(200, '{"id": "ch_1"}', { count: 10 })], { key_paths: keyPaths, ...extra })])),
    );

  it("an extra field sent shows a '+' line with its annotation, padded to a column", () => {
    const msg = missOf(charges('{"action": "pay"}', ["action"]), post("/v1/charges", '{"action": "pay", "metadata": {"coupon_code": "SAVE10"}}')).message;
    expect(msg).toContain(`    + ${"metadata.coupon_code".padEnd(36)}  sent, not in the recording`);
    expect(msg).toMatch(/^no recorded stub for POST \/v1\/charges {2}\(fingerprint [0-9a-f]{16}\)\n/);
    expect(msg).toContain("Closest recording");
    expect(msg).toContain("(seen 10x):");
    expect(msg.endsWith("  refresh the bundle:  stubsmith pull")).toBe(true);
  });

  it("a missing field shows a '-' line", () => {
    const msg = missOf(charges('{"action": "pay", "amount": 1}', ["action", "amount"]), post("/v1/charges", '{"action": "pay"}')).message;
    expect(msg).toContain(`    - ${"amount".padEnd(36)}  in the recording, not sent`);
    expect(msg).not.toContain("sent, not in the recording");
  });

  it("the content-type difference is shown when key paths match", () => {
    const e = charges('{"a": 1}', ["a"], { content_type: "application/json", query_names: [] });
    const msg = missOf(e, post("/v1/charges", '{"a": 1}', "text/plain")).message;
    expect(msg).toContain("    Content-Type:\n      sent:       text/plain\n      recording:  application/json");
  });

  it("a missing content type is shown as (none)", () => {
    const e = charges('{"a": 1}', ["a"], { content_type: "application/json", query_names: [] });
    const msg = missOf(e, { method: "POST", url: `https://${DOMAIN}/v1/charges`, body: '{"a": 1}' }).message;
    expect(msg).toContain("sent:       (none)");
  });

  it("query-name differences show as ?name lines in both directions", () => {
    const e = new ReplayEngine(
      bundle(endpoint("GET", "/s", [stub(fp("", "q=1&page=1", ""), [variant(200, "1")], { key_paths: [], query_names: ["q", "page"], content_type: "" })])),
    );
    const msg = missOf(e, get("/s?q=1&sort=asc")).message;
    expect(msg).toContain(`    + ${"?sort".padEnd(36)}  sent, not in the recording`);
    expect(msg).toContain(`    - ${"?page".padEnd(36)}  in the recording, not sent`);
  });

  it("claims an SDK symmetry bug only when all three fingerprint inputs were compared and agree", () => {
    const e = new ReplayEngine(
      bundle(endpoint("POST", "/x", [stub("0000000000000000", [variant(200, "1")], { key_paths: ["a"], query_names: [], content_type: "application/json" })])),
    );
    const msg = missOf(e, post("/x", '{"a": 1}')).message;
    expect(msg).toContain("The request appears structurally identical to recording 0000000000000000 but hashed differently.");
    expect(msg).toContain("fingerprint symmetry bug in the SDK");
  });

  it("says the fields cannot be compared when the bundle omits query names or content type", () => {
    const e = new ReplayEngine(bundle(endpoint("POST", "/x", [stub("0000000000000000", [variant(200, "1")], { key_paths: ["a"] })])));
    const msg = missOf(e, post("/x", '{"a": 1}')).message;
    expect(msg).toContain("key-paths are identical.");
    expect(msg).toContain("query-parameter names and content-type, which this bundle does not record.");
    expect(msg).toContain("  - query-parameter names: compare ?name=...");
    expect(msg).toContain("  - content-type: compare the Content-Type header");
    expect(msg).not.toContain("symmetry bug");

    const only = new ReplayEngine(bundle(endpoint("POST", "/x", [stub("0000000000000000", [variant(200, "1")], { key_paths: ["a"], query_names: [] })])));
    const msg2 = missOf(only, post("/x", '{"a": 1}')).message;
    expect(msg2).toContain("likely lies in content-type, which");
    expect(msg2).not.toContain("query-parameter names: compare");
  });

  it("bounds the output to the two closest of many recordings and states the total", () => {
    const stubs = [0, 1, 2, 3, 4].map((i) =>
      stub(fp(JSON.stringify({ action: "pay", [`field_${i}`]: "x" }), "", "application/json"), [variant(200, "{}", { count: i + 1 })], {
        key_paths: ["action", `field_${i}`],
      }),
    );
    const msg = missOf(new ReplayEngine(bundle(endpoint("POST", "/v1/charges", stubs))), post("/v1/charges", '{"action": "pay"}')).message;
    expect(msg).toContain("5 recordings found for this endpoint; showing the 2 closest.");
    expect(msg.match(/Closest recording/g)).toHaveLength(2);
  });

  it("ranks candidates by the size of the difference", () => {
    const far = stub(fp('{"a": 1, "x": 1, "y": 1, "z": 1}', "", "application/json"), [variant(200, "1")], { key_paths: ["a", "x", "y", "z"] });
    const near = stub(fp('{"a": 1, "b": 1}', "", "application/json"), [variant(200, "1")], { key_paths: ["a", "b"] });
    const mid = stub(fp('{"a": 1, "b": 1, "c": 1}', "", "application/json"), [variant(200, "1")], { key_paths: ["a", "b", "c"] });
    const msg = missOf(new ReplayEngine(bundle(endpoint("POST", "/r", [far, mid, near]))), post("/r", '{"a": 1}')).message;
    expect(msg.indexOf(near.fingerprint)).toBeGreaterThan(-1);
    expect(msg.indexOf(near.fingerprint)).toBeLessThan(msg.indexOf(mid.fingerprint));
    expect(msg).not.toContain(far.fingerprint.slice(0, 16) + "  (seen");
  });

  it("suppresses a parent path when a child also differs, but keeps a childless object", () => {
    const rec = charges('{"action": "pay"}', ["action"]);
    const msg = missOf(rec, post("/v1/charges", '{"action": "pay", "meta": {"a": 1, "b": 2}}')).message;
    expect(msg).toContain("+ meta.a");
    expect(msg).toContain("+ meta.b");
    expect(msg).not.toMatch(/\+ meta {2,}/);
    const childless = missOf(rec, post("/v1/charges", '{"action": "pay", "meta": {}}')).message;
    expect(childless).toMatch(/\+ meta {2,}sent, not in the recording/);
  });

  it("no endpoint: names the domain and lists same-method alternatives, bounded at six", () => {
    const eps = Array.from({ length: 8 }, (_, i) => endpoint("GET", `/e${i}`, [stub(FP_EMPTY_GET, [variant(200, "1")])]));
    eps.push(endpoint("GET", "/far", [stub(FP_EMPTY_GET, [variant(200, "1")])], { domain: "other.example.org" }));
    const msg = missOf(new ReplayEngine(bundle(...eps)), get("/nope")).message;
    expect(msg).toContain(`No traffic has been recorded for GET ${DOMAIN}.`);
    expect(msg).toContain("Endpoints recorded with GET in this bundle:\n  GET /e0\n  GET /e1");
    expect(msg).toContain("  … and 3 more");
    expect(msg).not.toContain("/e6");
    const other = missOf(new ReplayEngine(bundle(eps[8] as ReturnType<typeof endpoint>)), get("/nope")).message;
    expect(other).toContain("  GET other.example.org/far");
  });

  it("no endpoint of that method at all", () => {
    const msg = missOf(new ReplayEngine(bundle(endpoint("GET", "/a", [stub(FP_EMPTY_GET, [variant(200, "1")])]))), post("/a", "")).message;
    expect(msg).toContain(`No traffic has been recorded for POST ${DOMAIN}.`);
    expect(msg).toContain("No POST endpoints are recorded in this bundle.");
  });

  it("an endpoint with no stubs is reported like an unknown endpoint", () => {
    const msg = missOf(new ReplayEngine(bundle(endpoint("GET", "/a", []))), get("/a")).message;
    expect(msg).toContain("No traffic has been recorded for GET");
  });

  it("names the bundle file when one was loaded", () => {
    const e = new ReplayEngine(bundle(), { bundlePath: "/tmp/bundle.json" });
    expect(missOf(e, get("/x")).message.endsWith("\n[bundle loaded from: /tmp/bundle.json]")).toBe(true);
    expect(missOf(new ReplayEngine(bundle()), get("/x")).message).not.toContain("bundle loaded from");
  });

  it("StubNotFound has a name, and a default message when none is given", () => {
    const e = new StubNotFound("GET", "/x", "abc");
    expect(e.name).toBe("StubNotFound");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("no recorded stub for GET /x  (fingerprint abc)\n\n  refresh the bundle:  stubsmith pull");
  });
});

describe("statuses filter", () => {
  const b = bundle(
    endpoint("GET", "/o", [stub(FP_EMPTY_GET, [windowed(200, 5, [sample("a", "1"), sample("b", "2")]), windowed(500, 1, [sample("e", "9")])])]),
  );

  it("keeps only recordings of the requested statuses, and index/total describe the filtered window", () => {
    const e = new ReplayEngine(b, { statuses: new Set([200]) });
    e.serve(get("/o"));
    expect(e.served()[0]).toMatchObject({ status: 200, index: 0, total: 2 });
    const f = new ReplayEngine(b, { statuses: [500] });
    f.serve(get("/o"));
    expect(f.served()[0]).toMatchObject({ status: 500, index: 0, total: 1, exhausted: true });
  });

  it("a shape with none of the status throws naming the filter and the available statuses", () => {
    const miss = missOf(new ReplayEngine(b, { statuses: [429, 503] }), get("/o"));
    expect(miss.message).toContain("no recorded 429, 503 response for GET /o");
    expect(miss.message).toContain("statuses recorded for this shape: 200, 500");
    expect(miss.message).toContain("Either widen statuses");
  });
});

describe("stub matching edge cases", () => {
  it("the stub key includes the method: GET and DELETE with one fingerprint serve their own body", () => {
    const e = new ReplayEngine(
      bundle(
        endpoint("GET", "/api/items/{id}", [stub(FP_EMPTY_GET, [variant(200, '"read"')])]),
        endpoint("DELETE", "/api/items/{id}", [stub(FP_EMPTY_GET, [variant(204, '"deleted"')])]),
      ),
    );
    expect(text(e.serve(get("/api/items/3")).body)).toBe('"read"');
    expect(text(e.serve({ method: "DELETE", url: `https://${DOMAIN}/api/items/3` }).body)).toBe('"deleted"');
  });

  it("the cursor advances only the shapes touched in a pass", () => {
    const b = bundle(
      endpoint("GET", "/a", [stub(FP_EMPTY_GET, [variant(200, '"a0"'), variant(201, '"a1"'), variant(202, '"a2"')])]),
      endpoint("GET", "/b", [stub(FP_EMPTY_GET, [variant(200, '"b0"'), variant(201, '"b1"'), variant(202, '"b2"')])]),
    );
    const state = new PassState();
    const pass = (...paths: string[]): string[] => {
      const e = new ReplayEngine(b, { passState: state });
      const out = paths.map((p) => text(e.serve(get(p)).body));
      state.advance();
      return out;
    };
    expect(pass("/a", "/b")).toEqual(['"a0"', '"b0"']);
    expect(pass("/b")).toEqual(['"b1"']); // /a is skipped in pass 2
    expect(pass("/a", "/b")).toEqual(['"a1"', '"b2"']);
  });

  it("a miss message compares content types after normalisation (case, charset)", () => {
    const e = new ReplayEngine(
      bundle(
        endpoint("POST", "/ct", [
          stub(fp('{"a": 1}', "", "application/json"), [variant(200, "1")], { key_paths: ["a"], content_type: "application/json; charset=UTF-8", query_names: [] }),
        ]),
      ),
    );
    const same = missOf(e, { ...post("/ct", '{"b": 1}'), headers: { "content-type": "Application/JSON" } });
    expect(same.message).not.toContain("Content-Type:");
    const other = missOf(e, { ...post("/ct", '{"b": 1}'), headers: { "content-type": "Text/Plain; Charset=UTF-8" } });
    expect(other.message).toContain("sent:       text/plain\n");
    expect(other.message).toContain("recording:  application/json\n");
  });

  it("a Latin-1 request body is not decoded lossily: it fingerprints as the empty body", () => {
    const e = new ReplayEngine(
      bundle(
        endpoint("POST", "/l", [
          stub(fp('{"k": "x"}', "", "application/json"), [variant(200, '"json"')], { key_paths: ["k"] }),
          stub(fp("", "", "application/json"), [variant(200, '"empty"')]),
        ]),
      ),
    );
    const latin1 = Buffer.concat([Buffer.from('{"k": "'), Buffer.from([0xe9]), Buffer.from('"}')]);
    const r = { method: "POST", url: `https://${DOMAIN}/l`, headers: { "content-type": "application/json" }, body: new Uint8Array(latin1) };
    expect(text(e.serve(r).body)).toBe('"empty"');
  });
});
