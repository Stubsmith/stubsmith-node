import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../src/_version.js";
import { PrivacyPipeline } from "../../src/privacy/pipeline.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { toJsonValue } from "../helpers/vectors.js";

const base = { method: "get", reqHeaders: {}, reqBody: "", status: 200, respHeaders: {}, respBody: "" };

describe("PrivacyPipeline", () => {
  it("returns null instead of throwing on a catastrophic error", () => {
    const p = new PrivacyPipeline(new RulesCache());
    expect(p.process({ ...base, url: "http://[::1/x" })).toBeNull();
    expect(p.process({ ...base, url: "http://h/", method: undefined as unknown as string })).toBeNull();
  });

  it("uses the package version unless overridden, and keeps __proto__ header names as data", () => {
    const input = { ...base, url: "http://h/x", reqHeaders: JSON.parse('{"__proto__": "v", "Accept": "a"}') as Record<string, string> };
    const out = new PrivacyPipeline(new RulesCache()).process(input);
    expect(out?.sdk_version).toBe(VERSION);
    expect(Object.keys(out?.headers ?? {})).toEqual(["__proto__", "Accept"]);
    expect(out?.headers["Accept"]).toBe("a");
    expect(new PrivacyPipeline(new RulesCache(), { sdkVersion: "9" }).process(input)?.sdk_version).toBe("9");
  });

  it("sends host[:port] as the domain, never URL userinfo, and masks a free-text form body", () => {
    const out = new PrivacyPipeline(new RulesCache()).process({
      ...base,
      method: "post",
      url: "http://usr:SECRET_PW@api.example.com:8080/notes",
      reqHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
      reqBody: "Dear SECRET, your PIN is 1234",
    });
    expect(out?.domain).toBe("api.example.com:8080");
    expect(out?.req_body).toBe("<masked>");
    expect(out?.key_paths).toEqual([]);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("SECRET");
    expect(wire).not.toContain("usr");
  });

  it("never lets a raw image body into the payload", () => {
    const out = new PrivacyPipeline(new RulesCache()).process({
      ...base,
      url: "http://h/i.png",
      respHeaders: { "Content-Type": "image/png" },
      respBody: "RAW-PIXELS",
    });
    expect(out?.resp_body_encoding).toBe("base64");
    expect(out?.resp_body).not.toContain("RAW");
  });
});

describe("PrivacyPipeline degrade path", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["STUBSMITH_MASK_SALT"];
  });

  const req = {
    method: "post",
    url: "http://h/x?apikey=SECRET",
    reqHeaders: { "Content-Type": "application/json", Accept: "a/b", Authorization: "Bearer TOKEN" },
    reqBody: '{"a":"x1"}',
    status: 200,
    respHeaders: { "Content-Type": "application/json", "Set-Cookie": "sid=COOKIE", "Cache-Control": "no-cache" },
    respBody: '{"a":"x2"}',
  };

  // "\\q" is a bad replacement template: it only throws when re.sub-style replacement runs.
  const badRegex = [{ pattern: "x", replace: "\\q" }];

  function expectFullyMasked(out: ReturnType<PrivacyPipeline["process"]>): void {
    expect(out).not.toBeNull();
    expect(out?.novel).toBe(true);
    expect(out?.req_body).toBe('{"a": "<masked>"}');
    expect(out?.resp_body).toBe('{"a": "<masked>"}');
    const wire = JSON.stringify(out);
    for (const secret of ["x1", "x2", "SECRET", "TOKEN", "COOKIE"]) expect(wire).not.toContain(secret);
    expect(out?.headers).toEqual({ "Content-Type": "application/json", Accept: "a/b", Authorization: "<masked>" });
    expect(out?.resp_headers).toEqual({
      "Content-Type": "application/json",
      "Set-Cookie": "<masked>",
      "Cache-Control": "<masked>",
    });
    expect(out?.path).toBe("/x?apikey=%3Cmasked%3E");
  }

  it("masks everything and reports novel when a synced regex template throws at apply time", () => {
    const fp = new PrivacyPipeline(new RulesCache()).process(req)?.req_fingerprint as string;
    const cache = new RulesCache();
    cache.applySyncResponse(
      toJsonValue({
        cursor: "1",
        rules: [
          {
            fingerprint: fp,
            request_type: { domain: "h", method: "POST", path_template: "/x" },
            field_rules: [
              { path: "body.a", action: "keep" },
              { path: "resp.a", action: "keep" },
            ],
          },
        ],
        project_defaults: { regex_masks: badRegex },
      }),
    );
    expect(cache.lookup("h|POST|/x", fp)).not.toBeNull();
    expectFullyMasked(new PrivacyPipeline(cache).process(req));
  });
});

describe("PrivacyPipeline type labels", () => {
  afterEach(() => {
    delete process.env["STUBSMITH_MASK_SALT"];
  });

  // The salt is set so that a label used as a placeholder type would show up as a generated email.
  it("reports an email label without letting it decide masking or the placeholder", () => {
    process.env["STUBSMITH_MASK_SALT"] = "test-salt";
    const input = {
      method: "post",
      url: "http://h/x",
      reqHeaders: { "Content-Type": "application/json" },
      reqBody: '{"kept":"ana@example.com","unkept":"bo@example.com"}',
      status: 200,
      respHeaders: {},
      respBody: "",
    };
    const fp = new PrivacyPipeline(new RulesCache()).process(input)?.req_fingerprint as string;
    const cache = new RulesCache();
    cache.applySyncResponse(
      toJsonValue({
        cursor: "1",
        rules: [
          {
            fingerprint: fp,
            request_type: { domain: "h", method: "POST", path_template: "/x" },
            field_rules: [{ path: "body.kept", action: "keep" }],
          },
        ],
      }),
    );
    const out = new PrivacyPipeline(cache).process(input);
    expect(out?.novel).toBe(false);
    expect(out?.req_value_types).toEqual({ kept: "email", unkept: "email" });
    expect(out?.req_body).toBe('{"kept": "ana@example.com", "unkept": "<masked>"}');
  });
});

describe("PrivacyPipeline synced rules", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const call = (reqBody: string): Parameters<PrivacyPipeline["process"]>[0] => ({
    method: "POST",
    url: "https://api.example.com/v1/orders",
    reqHeaders: { "Content-Type": "application/json" },
    reqBody,
    status: 200,
    respHeaders: { "Content-Type": "application/json" },
    respBody: '{"id": 1, "status": "ok"}',
  });

  // A cache that holds one rule for the request's fingerprint, plus optional project defaults.
  function syncedCache(reqBody: string, fieldRules: unknown[], projectDefaults?: unknown): RulesCache {
    const fp = new PrivacyPipeline(new RulesCache()).process(call(reqBody))?.req_fingerprint as string;
    const cache = new RulesCache();
    const body = toJsonValue({
      ok: true,
      cursor: "1",
      rules: [
        {
          seq: 1,
          request_type: { domain: "api.example.com", method: "POST", path_template: "/v1/orders" },
          fingerprint: fp,
          field_rules: fieldRules,
        },
      ],
      path_templates: [],
      project_defaults: projectDefaults ?? null,
      request_type_value_config: {},
    });
    cache.applySyncResponse(body);
    return cache;
  }

  it("masks every field of a known fingerprint that has no keep rules", () => {
    const reqBody = '{"amount": 50, "name": "alice"}';
    const out = new PrivacyPipeline(syncedCache(reqBody, [])).process(call(reqBody));
    expect(out?.novel).toBe(false);
    expect(JSON.parse(out?.req_body as string)).toEqual({ amount: 0, name: "<masked>" });
  });

  it("masks kept strings but not kept numbers when a project regex does not compile", () => {
    const reqBody = JSON.stringify({ note: "hello", count: 3 });
    const cache = syncedCache(
      reqBody,
      [
        { path: "body.note", action: "keep" },
        { path: "body.count", action: "keep" },
      ],
      { field_masks: [], regex_masks: [{ pattern: "[[[" }] },
    );
    expect(cache.projectDefaults).not.toBeNull();
    const out = new PrivacyPipeline(cache).process(call(reqBody));
    expect(JSON.parse(out?.req_body as string)).toEqual({ note: "<masked>", count: 3 });
  });

  it("masks kept strings when compiling the project defaults throws", () => {
    const reqBody = JSON.stringify({ note: "hello" });
    const cache = new RulesCache();
    const fp = new PrivacyPipeline(new RulesCache()).process(call(reqBody))?.req_fingerprint as string;
    const body = toJsonValue({
      cursor: "1",
      rules: [
        {
          fingerprint: fp,
          request_type: { domain: "api.example.com", method: "POST", path_template: "/v1/orders" },
          field_rules: [{ path: "body.note", action: "keep" }],
        },
      ],
      project_defaults: { field_masks: ["x"] },
    }) as Map<string, Map<string, unknown>>;
    // A list that cannot be read, so compiling the defaults raises instead of returning rules.
    body.get("project_defaults")?.set(
      "field_masks",
      new Proxy(["x"], {
        get() {
          throw new Error("boom");
        },
      }),
    );
    cache.applySyncResponse(body);
    expect(cache.projectDefaults?.unusable).toBe(true);
    const out = new PrivacyPipeline(cache).process(call(reqBody));
    expect(JSON.parse(out?.req_body as string)).toEqual({ note: "<masked>" });
  });
});
