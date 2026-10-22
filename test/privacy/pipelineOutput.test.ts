import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIF_1X1, PNG_1X1 } from "../../src/privacy/binary.js";
import { PrivacyPipeline } from "../../src/privacy/pipeline.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { callProcess, dumps, makePipeline, makeSyncResponse, makeSyncedPipeline, mustPayload, reqFingerprint } from "../helpers/pipeline.js";

const FORM_CT = "application/x-www-form-urlencoded";
const DUMMY_PASSWORD = "hunter2";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["STUBSMITH_MASK_SALT"];
});

/** A pipeline whose cache holds one rule for `reqBody`, with the given field rules and project defaults. */
function known(
  reqBody: string,
  fieldRules: unknown[],
  o: { query?: string; contentType?: string; projectDefaults?: unknown } = {},
): { cache: RulesCache; pipeline: PrivacyPipeline } {
  const fp = reqFingerprint(reqBody, o.query ?? "", o.contentType ?? "application/json");
  return makeSyncedPipeline(makeSyncResponse(fp, fieldRules, o.projectDefaults === undefined ? {} : { projectDefaults: o.projectDefaults }));
}

describe("PrivacyPipeline basic output", () => {
  it("returns every required key", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline));
    for (const key of [
      "sdk_version", "sdk_masked", "sdk_rule_version", "domain", "path_template", "path", "method", "status",
      "req_fingerprint", "resp_fingerprint", "key_paths", "resp_key_paths", "req_header_names", "resp_header_names",
      "query_names", "headers", "req_body", "resp_headers", "resp_body", "novel",
    ]) {
      expect(result, `missing key: ${key}`).toHaveProperty(key);
    }
  });

  it("always sets sdk_masked", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline)).sdk_masked).toBe(true);
  });

  it("parses the domain from the URL", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline, { url: "https://api.example.com/v1/orders" })).domain).toBe("api.example.com");
  });

  it("uppercases the method", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline, { method: "get" })).method).toBe("GET");
  });

  it("reports the status", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline, { status: 201 })).status).toBe(201);
  });

  it("makes the path field usable on its own: templated path plus masked query", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { url: "https://api.example.com/v1/orders?page=2" }));
    expect(result.path.startsWith("/v1/orders")).toBe(true);
    expect(result.path).toContain("page");
  });

  it("masks query values in the path field and keeps the names", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { url: "https://api.example.com/v1/orders?secret=abc123&page=1" }));
    expect(result.path).not.toContain("abc123");
    expect(result.path).toContain("secret");
  });
});

describe("PrivacyPipeline novel fingerprint", () => {
  it("flags an unknown fingerprint as novel", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline)).novel).toBe(true);
  });

  it("fully masks a novel request body", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { reqBody: '{"password": "s3cr3t", "count": 5}' }));
    const obj = JSON.parse(result.req_body) as Record<string, unknown>;
    expect(obj["password"]).toBe("<masked>");
    expect(obj["count"]).toBe(0);
  });
});

describe("PrivacyPipeline path name arrays", () => {
  it("lists request body key names", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { reqBody: '{"user": {"email": "x"}, "amount": 99}' }));
    for (const k of ["user", "user.email", "amount"]) expect(result.key_paths).toContain(k);
  });

  it("lists response key names, never values", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { respBody: '{"id": 1, "status": "ok", "meta": {"ts": 123}}' }));
    for (const k of ["id", "status", "meta", "meta.ts"]) expect(result.resp_key_paths).toContain(k);
    expect(result.resp_key_paths).not.toContain("ok");
  });

  it("has no response key names for an empty response body", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline, { respBody: "" })).resp_key_paths).toEqual([]);
  });

  it("lowercases request header names and carries no values", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(
      callProcess(pipeline, {
        reqHeaders: { "Content-Type": "application/json", Authorization: "Bearer tok", "X-Request-Id": "req-123" },
      }),
    );
    for (const n of ["content-type", "authorization", "x-request-id"]) expect(result.req_header_names).toContain(n);
    for (const v of ["Bearer tok", "req-123", "application/json"]) expect(result.req_header_names).not.toContain(v);
  });

  it("lowercases response header names and carries no values", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(
      callProcess(pipeline, { respHeaders: { "Content-Type": "application/json", "X-Trace-Id": "trace-abc" } }),
    );
    expect(result.resp_header_names).toContain("content-type");
    expect(result.resp_header_names).toContain("x-trace-id");
    expect(result.resp_header_names).not.toContain("trace-abc");
  });

  it("lists the unique query names and no values", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(
      callProcess(pipeline, { url: "https://api.example.com/v1/orders?page=2&sort=asc&tag=foo&tag=bar" }),
    );
    for (const n of ["page", "sort", "tag"]) expect(result.query_names).toContain(n);
    for (const v of ["2", "asc", "foo"]) expect(result.query_names).not.toContain(v);
  });

  it("has no query names when there is no query string", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline, { url: "https://api.example.com/v1/orders" })).query_names).toEqual([]);
  });

  it("always gives the four arrays as lists", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline));
    for (const field of ["resp_key_paths", "req_header_names", "resp_header_names", "query_names"] as const) {
      expect(Array.isArray(result[field]), `${field} must be a list`).toBe(true);
    }
  });

  it("never puts response values in the response key paths", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { respBody: '{"secret": "hunter2", "count": 42}' }));
    expect(result.resp_key_paths).not.toContain("hunter2");
    expect(result.resp_key_paths).not.toContain("42");
  });
});

describe("PrivacyPipeline known fingerprint", () => {
  it("does not flag a known fingerprint as novel", () => {
    const reqBody = '{"amount": 50, "user_id": 7}';
    const { pipeline } = known(reqBody, [{ path: "body.amount", action: "keep" }]);
    expect(mustPayload(callProcess(pipeline, { reqBody })).novel).toBe(false);
  });

  it("applies a synced keep rule", () => {
    const reqBody = '{"amount": 50, "secret": "tok"}';
    const { pipeline } = known(reqBody, [{ path: "body.amount", action: "keep" }]);
    const obj = JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body) as Record<string, unknown>;
    expect(obj["amount"]).toBe(50);
    expect(obj["secret"]).toBe("<masked>");
  });
});

describe("PrivacyPipeline response field rules", () => {
  it("keeps a response field with a resp keep rule", () => {
    const reqBody = '{"action": "buy"}';
    const { pipeline } = known(reqBody, [{ path: "resp.id", action: "keep" }]);
    const result = mustPayload(callProcess(pipeline, { reqBody, respBody: JSON.stringify({ id: 42, secret: "tok" }) }));
    const obj = JSON.parse(result.resp_body) as Record<string, unknown>;
    expect(obj["id"]).toBe(42);
    expect(obj["secret"]).toBe("<masked>");
  });

  it("gives response scalars 0, <masked> and false when no rules are synced", () => {
    const reqBody = '{"action": "buy"}';
    const { pipeline } = known(reqBody, []);
    const result = mustPayload(callProcess(pipeline, { reqBody, respBody: JSON.stringify({ id: 7, status: "ok", active: true }) }));
    const obj = JSON.parse(result.resp_body) as Record<string, unknown>;
    expect(obj["id"]).toBe(0);
    expect(obj["status"]).toBe("<masked>");
    expect(obj["active"]).toBe(false);
  });

  it("does not let request body keep rules keep response fields", () => {
    const reqBody = '{"amount": 99}';
    const { pipeline } = known(reqBody, [{ path: "body.amount", action: "keep" }]);
    const result = mustPayload(callProcess(pipeline, { reqBody, respBody: JSON.stringify({ amount: 99, secret: "tok" }) }));
    expect((JSON.parse(result.req_body) as Record<string, unknown>)["amount"]).toBe(99);
    const respObj = JSON.parse(result.resp_body) as Record<string, unknown>;
    expect(respObj["amount"]).toBe(0);
    expect(respObj["secret"]).toBe("<masked>");
  });

  it("sends a kept response string with an email as it is", () => {
    const reqBody = '{"action": "query"}';
    const { pipeline } = known(reqBody, [
      { path: "resp.note", action: "keep" },
      { path: "resp.id", action: "keep" },
    ]);
    const result = mustPayload(
      callProcess(pipeline, { reqBody, respBody: JSON.stringify({ note: "contact alice@example.com please", id: 1 }) }),
    );
    const obj = JSON.parse(result.resp_body) as Record<string, unknown>;
    expect(obj["note"]).toBe("contact alice@example.com please");
    expect(obj["id"]).toBe(1);
  });

  it("keeps the named leaf of a response array and masks the others", () => {
    const reqBody = '{"action": "list"}';
    const { pipeline } = known(reqBody, [{ path: "resp.items.[].price", action: "keep" }]);
    const result = mustPayload(
      callProcess(pipeline, { reqBody, respBody: JSON.stringify({ items: [{ price: 10, secret: "x" }] }) }),
    );
    const obj = JSON.parse(result.resp_body) as { items: Array<Record<string, unknown>> };
    expect(obj.items[0]?.["price"]).toBe(10);
    expect(obj.items[0]?.["secret"]).toBe("<masked>");
  });

  it("fully masks the response body of a novel fingerprint", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { respBody: JSON.stringify({ id: 7, email: "user@example.com" }) }));
    expect(result.novel).toBe(true);
    const obj = JSON.parse(result.resp_body) as Record<string, unknown>;
    expect(obj["id"]).toBe(0);
    expect(obj["email"]).toBe("<masked>");
  });

  it("keeps only the named leaf of a nested resp keep rule", () => {
    const reqBody = '{"action": "get"}';
    const { pipeline } = known(reqBody, [{ path: "resp.user.name", action: "keep" }]);
    const result = mustPayload(
      callProcess(pipeline, { reqBody, respBody: JSON.stringify({ user: { name: "alice", token: "secret" } }) }),
    );
    const obj = JSON.parse(result.resp_body) as { user: Record<string, unknown> };
    expect(obj.user["name"]).toBe("alice");
    expect(obj.user["token"]).toBe("<masked>");
  });

  it("masks response headers of a novel fingerprint except allowlisted ones", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { respHeaders: { "content-type": "application/json", "x-secret": "tok" } }));
    expect(result.novel).toBe(true);
    expect(result.resp_headers["x-secret"]).toBe("<masked>");
    expect(result.resp_headers["content-type"]).toBe("application/json");
  });
});

describe("PrivacyPipeline project defaults", () => {
  const emailRegex = String.raw`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`;

  it("masks a match of a synced project regex inside a kept string", () => {
    const reqBody = dumps({ note: "contact alice@example.com for details", count: 1 });
    const { pipeline } = known(reqBody, [{ path: "body.note", action: "keep" }], {
      projectDefaults: { field_masks: [], regex_masks: [{ pattern: emailRegex, replace: "<masked>", flags: "" }] },
    });
    const obj = JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body) as { note: string };
    expect(obj.note).not.toContain("alice@example.com");
    expect(obj.note).toContain("<masked>");
  });

  it("masks a kept field whose name matches a synced field mask", () => {
    const reqBody = dumps({ token: "super-secret", count: 5 });
    const { pipeline } = known(reqBody, [{ path: "body.token", action: "keep" }], {
      projectDefaults: { field_masks: ["token"], regex_masks: [] },
    });
    expect(JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body)).toEqual({ token: "<masked>", count: 0 });
  });

  it("sends kept values as they are when no project defaults are synced", () => {
    const reqBody = dumps({ note: "reach ana@example.com please", card: "4111111111111111", count: 2 });
    const { pipeline } = known(
      reqBody,
      [
        { path: "body.note", action: "keep" },
        { path: "body.card", action: "keep" },
      ],
    );
    expect(JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body)).toEqual({
      note: "reach ana@example.com please",
      card: "4111111111111111",
      count: 0,
    });
  });

  it("stores synced project defaults compiled", () => {
    const reqBody = dumps({ x: 1 });
    const { cache } = known(reqBody, [], { projectDefaults: { field_masks: ["secret"], regex_masks: [] } });
    expect(cache.projectDefaults?.fieldMasks.has("secret")).toBe(true);
  });

  it("leaves a kept email verbatim when the project defaults are empty", () => {
    const reqBody = dumps({ note: "contact carol@example.com please", x: 1 });
    const { pipeline } = known(reqBody, [{ path: "body.note", action: "keep" }], {
      projectDefaults: { field_masks: [], regex_masks: [] },
    });
    expect(JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body)).toEqual({
      note: "contact carol@example.com please",
      x: 0,
    });
  });

  it("applies the cursor and rules even when project defaults are malformed, and stores them as unusable", () => {
    const reqBody = dumps({ amount: 50 });
    const fp = reqFingerprint(reqBody);
    const { cache, pipeline } = makeSyncedPipeline(
      makeSyncResponse(fp, [{ path: "body.amount", action: "keep" }], {
        cursor: "99",
        projectDefaults: { field_masks: [1, null, true], regex_masks: [{ pattern: null }] },
      }),
    );
    expect(cache.cursor).toBe("99");
    expect(cache.projectDefaults?.unusable).toBe(true);
    const obj = JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body) as Record<string, unknown>;
    expect(obj["amount"]).toBe(50);
  });

  it("keeps the valid field masks when one regex entry is malformed, and masks kept strings", () => {
    const reqBody = dumps({ password: DUMMY_PASSWORD, note: "hello", n: 1 });
    const { cache, pipeline } = known(
      reqBody,
      [
        { path: "body.password", action: "keep" },
        { path: "body.note", action: "keep" },
        { path: "body.n", action: "keep" },
      ],
      { projectDefaults: { field_masks: ["password"], regex_masks: [{ pattern: 5 }] } },
    );
    expect(cache.projectDefaults?.fieldMasks.has("password")).toBe(true);
    expect(JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body)).toEqual({
      password: "<masked>",
      note: "<masked>",
      n: 1,
    });
  });
});

describe("PrivacyPipeline labels", () => {
  // The salt is set so that a label used as a placeholder type would show up as a generated value.
  it("reports a label without letting it decide masking or the placeholder", () => {
    process.env["STUBSMITH_MASK_SALT"] = "test-salt";
    const reqBody = dumps({ kept: "ana@example.com", unkept: "bo@example.com" });
    const { pipeline } = known(reqBody, [{ path: "body.kept", action: "keep" }]);
    const result = mustPayload(callProcess(pipeline, { reqBody }));
    expect(result.req_value_types).toEqual({ kept: "email", unkept: "email" });
    expect(JSON.parse(result.req_body)).toEqual({ kept: "ana@example.com", unkept: "<masked>" });
  });
});

describe("PrivacyPipeline project defaults that are not an object", () => {
  it.each([[[]], ["rules"], [5]])("masks kept strings when project_defaults is %j", (projectDefaults) => {
    const reqBody = dumps({ note: "hello", n: 1 });
    const { cache, pipeline } = known(
      reqBody,
      [
        { path: "body.note", action: "keep" },
        { path: "body.n", action: "keep" },
      ],
      { projectDefaults },
    );
    expect(cache.projectDefaults?.unusable).toBe(true);
    expect(JSON.parse(mustPayload(callProcess(pipeline, { reqBody })).req_body)).toEqual({ note: "<masked>", n: 1 });
  });
});

describe("PrivacyPipeline project field masks", () => {
  it("overrides keeps in JSON bodies, query and request and response headers and bodies", () => {
    const query = `password=${DUMMY_PASSWORD}&page=2`;
    const reqBody = dumps({
      password: DUMMY_PASSWORD,
      user: { name: "Ana", Password: DUMMY_PASSWORD },
      items: [{ sku: "A1", password: DUMMY_PASSWORD }],
      reset: { password: { old: DUMMY_PASSWORD, new: DUMMY_PASSWORD } },
      history: { password: [{ hint: DUMMY_PASSWORD }] },
      count: 3,
    });
    const respBody = dumps({ id: 9, password: DUMMY_PASSWORD, pin: { password: DUMMY_PASSWORD } });
    const keep = [
      "body.password", "body.user.name", "body.user.Password",
      "body.items.[].sku", "body.items.[].password",
      "body.reset.password.old", "body.reset.password.new", "body.count",
      "body.history.password.[].hint", "resp:200.pin.password", "resp_header:200.x-password",
      "query.password", "query.page",
      "header.x-password", "header.x-trace",
      "resp.id", "resp.password",
      "resp_header.x-password", "resp_header.x-trace",
    ];
    const fp = reqFingerprint(reqBody, query);
    const { pipeline } = makeSyncedPipeline(
      makeSyncResponse(fp, keep.map((path) => ({ path, action: "keep" })), {
        projectDefaults: { field_masks: ["password", " X-Password "], regex_masks: [] },
      }),
    );
    const result = mustPayload(
      callProcess(pipeline, {
        url: `https://api.example.com/v1/orders?${query}`,
        reqHeaders: { "Content-Type": "application/json", "X-Password": DUMMY_PASSWORD, "X-Trace": "t-1" },
        reqBody,
        respHeaders: { "Content-Type": "application/json", "X-Password": DUMMY_PASSWORD, "X-Trace": "t-2" },
        respBody,
      }),
    );
    expect(JSON.stringify(result)).not.toContain(DUMMY_PASSWORD);
    expect(result.novel).toBe(false);
    expect(result.path).toBe("/v1/orders?password=%3Cmasked%3E&page=2");
    expect(result.headers).toEqual({ "Content-Type": "application/json", "X-Password": "<masked>", "X-Trace": "t-1" });
    expect(JSON.parse(result.req_body)).toEqual({
      password: "<masked>",
      user: { name: "Ana", Password: "<masked>" },
      items: [{ sku: "A1", password: "<masked>" }],
      reset: { password: { old: "<masked>", new: "<masked>" } },
      history: { password: [{ hint: "<masked>" }] },
      count: 3,
    });
    expect(result.resp_headers).toEqual({ "Content-Type": "application/json", "X-Password": "<masked>", "X-Trace": "t-2" });
    expect(JSON.parse(result.resp_body)).toEqual({ id: 9, password: "<masked>", pin: { password: "<masked>" } });
  });

  it("overrides keeps in a form body", () => {
    const reqBody = `username=ana&password=${DUMMY_PASSWORD}`;
    const fp = reqFingerprint(reqBody, "", FORM_CT);
    const { pipeline } = makeSyncedPipeline(
      makeSyncResponse(
        fp,
        [
          { path: "body.username", action: "keep" },
          { path: "body.password", action: "keep" },
        ],
        { projectDefaults: { field_masks: ["password"], regex_masks: [] } },
      ),
    );
    const result = mustPayload(callProcess(pipeline, { reqHeaders: { "Content-Type": FORM_CT }, reqBody }));
    expect(result.req_body).toBe("username=ana&password=%3Cmasked%3E");
  });
});

describe("PrivacyPipeline image bodies", () => {
  it("replaces a request image body with a base64 1x1 GIF", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { reqHeaders: { "Content-Type": "image/gif" }, reqBody: "real-gif-pixels" }));
    expect(result.req_body_encoding).toBe("base64");
    expect(Buffer.from(result.req_body, "base64")).toEqual(Buffer.from(GIF_1X1));
  });

  it("replaces a response image body with a base64 1x1 PNG", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { respHeaders: { "Content-Type": "image/png" }, respBody: "real-png-pixels" }));
    expect(result.resp_body_encoding).toBe("base64");
    expect(Buffer.from(result.resp_body, "base64")).toEqual(Buffer.from(PNG_1X1));
  });

  it("never lets the raw image request bytes into the payload", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { reqHeaders: { "Content-Type": "image/png" }, reqBody: "pixels" }));
    expect(result.req_body).not.toContain("pixels");
  });

  it("has no body encoding field for a non-image payload", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline));
    expect(result).not.toHaveProperty("req_body_encoding");
    expect(result).not.toHaveProperty("resp_body_encoding");
  });
});

describe("PrivacyPipeline repeated query parameters", () => {
  it("masks every value in a novel request", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { url: "https://api.example.com/v1/orders?tag=foo&tag=bar&secret=xyz" }));
    for (const v of ["foo", "bar", "xyz"]) expect(result.path).not.toContain(v);
  });

  it("keeps the names in the path", () => {
    const { pipeline } = makePipeline();
    const result = mustPayload(callProcess(pipeline, { url: "https://api.example.com/v1/orders?tag=foo&tag=bar" }));
    expect(result.path).toContain("tag");
  });
});

describe("PrivacyPipeline fingerprint value discrimination", () => {
  const endpointId = "api.example.com|POST|/v1/rpc";
  const url = "https://api.example.com/v1/rpc";
  const withConfig = (valuePaths: string[]): { cache: RulesCache; pipeline: PrivacyPipeline } =>
    makeSyncedPipeline(
      makeSyncResponse("placeholder", [], { pathTemplate: "/v1/rpc", valueConfig: { [endpointId]: valuePaths } }),
    );

  it("gives different fingerprints for different values at a configured path", () => {
    const { pipeline } = withConfig(["action"]);
    const r1 = mustPayload(callProcess(pipeline, { url, reqBody: dumps({ action: "login", token: "secret" }) }));
    const r2 = mustPayload(callProcess(pipeline, { url, reqBody: dumps({ action: "logout", token: "secret" }) }));
    expect(r1.req_fingerprint).not.toBe(r2.req_fingerprint);
  });

  it("gives the same fingerprint for the same value", () => {
    const { pipeline } = withConfig(["action"]);
    const reqBody = dumps({ action: "login", token: "secret" });
    const r1 = mustPayload(callProcess(pipeline, { url, reqBody }));
    const r2 = mustPayload(callProcess(pipeline, { url, reqBody }));
    expect(r1.req_fingerprint).toBe(r2.req_fingerprint);
  });

  it("carries the fingerprint value paths in the payload", () => {
    const { pipeline } = withConfig(["action"]);
    expect(mustPayload(callProcess(pipeline, { url, reqBody: dumps({ action: "login" }) })).fingerprint_value_paths).toEqual(["action"]);
  });

  it("carries path names, never values", () => {
    const { pipeline } = withConfig(["action"]);
    const result = mustPayload(callProcess(pipeline, { url, reqBody: dumps({ action: "supersecret" }) }));
    expect(result.fingerprint_value_paths ?? []).not.toContain("supersecret");
  });

  it("gives the same fingerprint for the same body without a config", () => {
    const { pipeline } = makePipeline();
    const reqBody = dumps({ action: "login" });
    const r1 = mustPayload(callProcess(pipeline, { reqBody }));
    const r2 = mustPayload(callProcess(pipeline, { reqBody }));
    expect(r1.req_fingerprint).toBe(r2.req_fingerprint);
  });

  it("has no fingerprint_value_paths key without a config", () => {
    const { pipeline } = makePipeline();
    expect(mustPayload(callProcess(pipeline))).not.toHaveProperty("fingerprint_value_paths");
  });

  it("gives a different fingerprint with a config than without", () => {
    const { pipeline: withP } = withConfig(["action"]);
    const { pipeline: withoutP } = makePipeline();
    const reqBody = dumps({ action: "login" });
    const rWith = mustPayload(callProcess(withP, { url, reqBody }));
    const rWithout = mustPayload(callProcess(withoutP, { url, reqBody }));
    expect(rWith.req_fingerprint).not.toBe(rWithout.req_fingerprint);
  });

  it("clears the value paths when a later sync has an empty config", () => {
    const { cache, pipeline } = withConfig(["action"]);
    expect(cache.getValuePaths(endpointId)).toEqual(["action"]);
    cache.applySyncResponse(makeSyncResponse("placeholder", [], { pathTemplate: "/v1/rpc", valueConfig: {} }));
    expect(cache.getValuePaths(endpointId)).toEqual([]);
    const result = mustPayload(callProcess(pipeline, { url, reqBody: dumps({ action: "login" }) }));
    expect(result).not.toHaveProperty("fingerprint_value_paths");
  });

  it("leaves the config unchanged when a sync has no config key", () => {
    const { cache } = withConfig(["action"]);
    expect(cache.getValuePaths(endpointId)).toEqual(["action"]);
    cache.applySyncResponse(makeSyncResponse("placeholder", [], { pathTemplate: "/v1/rpc" }));
    expect(cache.getValuePaths(endpointId)).toEqual(["action"]);
  });

  it("replaces the previous config fully on a later sync", () => {
    const ep2 = "api.example.com|POST|/v1/other";
    const cache = new RulesCache();
    cache.applySyncResponse(
      makeSyncResponse("placeholder", [], { pathTemplate: "/v1/rpc", valueConfig: { [endpointId]: ["action"], [ep2]: ["type"] } }),
    );
    expect(cache.getValuePaths(endpointId)).toEqual(["action"]);
    expect(cache.getValuePaths(ep2)).toEqual(["type"]);
    cache.applySyncResponse(makeSyncResponse("placeholder", [], { pathTemplate: "/v1/rpc", valueConfig: { [endpointId]: ["cmd"] } }));
    expect(cache.getValuePaths(endpointId)).toEqual(["cmd"]);
    expect(cache.getValuePaths(ep2)).toEqual([]);
  });

  it("skips a non-string path entry", () => {
    const { cache } = withConfig(["action", 42 as unknown as string, null as unknown as string, "type"]);
    expect(cache.getValuePaths(endpointId)).toEqual(["action", "type"]);
  });
});
