import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFieldRules, applyRespFieldRules, compileFieldRules } from "../../src/privacy/fieldRules.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { loadVectors, toJsonValue } from "../helpers/vectors.js";

interface In {
  body: string;
  content_type: string;
  email_domain: string | null;
  field_rules: unknown[];
  headers: Record<string, string>;
  project_defaults: unknown;
  query: string;
  resp_body: string;
  resp_content_type: string;
  resp_headers: Record<string, string>;
  resp_status: number | null;
  salt: string | null;
}
interface Ex {
  masked_body: string;
  masked_headers: Record<string, string>;
  masked_query: string;
  masked_resp_body: string;
  masked_resp_headers: Record<string, string>;
}

const file = loadVectors<In, Ex>("field-rules-extra.json");

describe("field-rules-extra conformance vectors", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["STUBSMITH_MASK_SALT"];
  });

  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const i = c.input;
    if (i.salt) process.env["STUBSMITH_MASK_SALT"] = i.salt;
    else delete process.env["STUBSMITH_MASK_SALT"];
    // Project defaults go through the cache merge: defaults that compile to nothing are stored as none.
    const cache = new RulesCache();
    if (i.project_defaults !== null) cache.applySyncResponse(toJsonValue({ project_defaults: i.project_defaults }));
    const compiled = compileFieldRules(toJsonValue(i.field_rules));
    const opts = { extraRules: cache.projectDefaults, emailDomain: i.email_domain };
    const [body, headers, query] = applyFieldRules(i.body, i.headers, i.query, i.content_type, compiled, opts);
    const [respBody, respHeaders] = applyRespFieldRules(
      i.resp_body,
      i.resp_headers,
      i.resp_content_type,
      compiled,
      i.resp_status,
      opts,
    );
    expect(body).toBe(c.expected.masked_body);
    expect(Object.fromEntries(headers)).toEqual(c.expected.masked_headers);
    expect(query).toBe(c.expected.masked_query);
    expect(respBody).toBe(c.expected.masked_resp_body);
    expect(Object.fromEntries(respHeaders)).toEqual(c.expected.masked_resp_headers);
  });
});
