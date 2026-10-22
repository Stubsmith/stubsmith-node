import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../src/_version.js";
import { PrivacyPipeline } from "../../src/privacy/pipeline.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { loadVectors, plain, toJsonValue } from "../helpers/vectors.js";

interface In {
  request: {
    method: string;
    url: string;
    req_headers: Record<string, string>;
    req_body: string;
    resp_status: number;
    resp_headers: Record<string, string>;
    resp_body: string;
  };
  salt: string | null;
  state: { kind: "none" | "sync"; sync?: unknown };
}
interface Ex {
  payload: Record<string, unknown>;
}

const file = loadVectors<In, Ex>("payload.json");

describe("payload conformance vectors", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["STUBSMITH_MASK_SALT"];
  });

  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    if (c.input.salt) process.env["STUBSMITH_MASK_SALT"] = c.input.salt;
    else delete process.env["STUBSMITH_MASK_SALT"];

    const cache = new RulesCache();
    const st = c.input.state;
    if (st.kind === "sync") cache.applySyncResponse(toJsonValue(st.sync));

    const r = c.input.request;
    const payload = new PrivacyPipeline(cache).process({
      method: r.method,
      url: r.url,
      reqHeaders: r.req_headers,
      reqBody: r.req_body,
      status: r.resp_status,
      respHeaders: r.resp_headers,
      respBody: r.resp_body,
    });
    expect(payload).not.toBeNull();
    const actual = plain<Record<string, unknown>>(payload);
    // The vectors record the Python SDK version; only its presence is compared.
    expect(actual["sdk_version"]).toBe(VERSION);
    delete actual["sdk_version"];
    const expected = { ...c.expected.payload };
    expect(typeof expected["sdk_version"]).toBe("string");
    delete expected["sdk_version"];
    expect(actual).toEqual(expected);
  });
});
