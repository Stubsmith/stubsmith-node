import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivacyPipeline as PrivacyPipelineType } from "../../src/privacy/pipeline.js";
import type { RulesCache } from "../../src/privacy/rulesCache.js";

// The setup file has already loaded the real modules, so load the pipeline again after the mocks below are in place.
let PrivacyPipeline: typeof PrivacyPipelineType;
let h: typeof import("../helpers/pipeline.js");

beforeAll(async () => {
  vi.resetModules();
  h = await import("../helpers/pipeline.js");
  ({ PrivacyPipeline } = await import("../../src/privacy/pipeline.js"));
});

// Each switch makes one step of the pipeline raise, the way an unexpected internal failure would.
const fail = vi.hoisted(() => ({ fieldRules: false, maskAll: false, urlParse: false }));

vi.mock("../../src/privacy/fieldRules.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/privacy/fieldRules.js")>();
  return {
    ...real,
    applyFieldRules: (...args: Parameters<typeof real.applyFieldRules>) => {
      if (fail.fieldRules) throw new Error("injected masking failure");
      return real.applyFieldRules(...args);
    },
  };
});

vi.mock("../../src/privacy/masking.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/privacy/masking.js")>();
  return {
    ...real,
    maskAll: (...args: Parameters<typeof real.maskAll>) => {
      if (fail.maskAll) throw new Error("total failure");
      return real.maskAll(...args);
    },
  };
});

vi.mock("../../src/internal/pyurl.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/internal/pyurl.js")>();
  return {
    ...real,
    pyUrlParse: (...args: Parameters<typeof real.pyUrlParse>) => {
      if (fail.urlParse) throw new Error("bad url");
      return real.pyUrlParse(...args);
    },
  };
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  fail.fieldRules = false;
  fail.maskAll = false;
  fail.urlParse = false;
  vi.restoreAllMocks();
});

describe("PrivacyPipeline fail closed", () => {
  it("degrades to mask-all and marks the payload novel when applying field rules raises", () => {
    const reqBody = '{"user": "alice", "token": "s3cr3t"}';
    const { pipeline } = h.makeSyncedPipeline(
      h.makeSyncResponse(h.reqFingerprint(reqBody), [{ path: "body.user", action: "keep" }]),
    );
    fail.fieldRules = true;
    const result = h.mustPayload(h.callProcess(pipeline, { reqBody }));
    const obj = JSON.parse(result.req_body) as Record<string, unknown>;
    expect(obj["token"]).toBe("<masked>");
    expect(obj["user"]).toBe("<masked>");
    expect(result.novel).toBe(true);
  });

  it("returns null when mask-all raises as well", () => {
    const { pipeline } = h.makePipeline();
    fail.maskAll = true;
    expect(h.callProcess(pipeline, { reqBody: '{"sensitive": "data"}' })).toBeNull();
  });

  it("returns null for a URL that cannot be parsed", () => {
    const { pipeline } = h.makePipeline();
    fail.urlParse = true;
    expect(pipeline.process({ method: "GET", url: "bad-url", reqHeaders: {}, reqBody: "", status: 200, respHeaders: {}, respBody: "" })).toBeNull();
  });

  it("returns null and never raises when the rules cache raises", () => {
    const cache = {
      get pathTemplates(): never {
        throw new Error("boom");
      },
    } as unknown as RulesCache;
    const pipeline = new PrivacyPipeline(cache);
    expect(
      pipeline.process({ method: "GET", url: "https://example.com/", reqHeaders: {}, reqBody: "", status: 200, respHeaders: {}, respBody: "" }),
    ).toBeNull();
  });
});

describe("PrivacyPipeline value types", () => {
  it("carries req_value_types", () => {
    const { pipeline } = h.makePipeline();
    const payload = h.mustPayload(
      pipeline.process({
        method: "POST",
        url: "https://api.example.com/v1/charge",
        reqHeaders: { "content-type": "application/json" },
        reqBody: h.dumps({ user_id: 42, email: "a@b.com" }),
        status: 200,
        respHeaders: { "content-type": "application/json" },
        respBody: h.dumps({ ok: true }),
      }),
    );
    expect(payload.req_value_types?.["user_id"]).toBe("integer_id");
    expect(payload.req_value_types?.["email"]).toBe("email");
  });

  it("carries resp_value_types", () => {
    const { pipeline } = h.makePipeline();
    const payload = h.mustPayload(
      pipeline.process({
        method: "GET",
        url: "https://api.example.com/v1/charge/1",
        reqHeaders: {},
        reqBody: "",
        status: 200,
        respHeaders: { "content-type": "application/json" },
        respBody: h.dumps({ charge_id: "ch_3Nk9BQ2eZvKYlo2C1b2X", amount: 999 }),
      }),
    );
    // charge_id is a mixed-alphanumeric string with no recognised format, so it is free_text.
    expect(payload.resp_value_types?.["charge_id"]).toBe("free_text");
    expect(payload.resp_value_types?.["amount"]).toBe("integer_id");
  });

  it("leaves the value types out when there are none", () => {
    const { pipeline } = h.makePipeline();
    const payload = h.mustPayload(
      pipeline.process({
        method: "POST",
        url: "https://api.example.com/v1/test",
        reqHeaders: { "content-type": "application/json" },
        reqBody: h.dumps({ active: true, deleted: false }),
        status: 200,
        respHeaders: { "content-type": "application/json" },
        respBody: "",
      }),
    );
    expect(payload).not.toHaveProperty("req_value_types");
    expect(payload).not.toHaveProperty("resp_value_types");
  });
});
