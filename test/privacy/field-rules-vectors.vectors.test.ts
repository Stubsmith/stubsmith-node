import { describe, expect, it } from "vitest";
import { parseQs } from "../../src/internal/pyqs.js";
import { applyFieldRules, applyRespFieldRules, compileFieldRules } from "../../src/privacy/fieldRules.js";
import { normaliseContentType } from "../../src/privacy/fingerprint.js";
import { toJsonValue } from "../helpers/vectors.js";
import { readFileSync } from "node:fs";

interface Vec {
  name: string;
  field_rules: unknown[];
  resp_status?: number;
  input: {
    body: string;
    content_type: string;
    headers: Record<string, string>;
    query: string;
    resp_body: string;
    resp_content_type: string;
    resp_headers: Record<string, string>;
  };
  expected: {
    masked_body: unknown;
    masked_headers: Record<string, string>;
    masked_query: Record<string, string[]>;
    masked_resp_body: unknown;
    masked_resp_headers: Record<string, string>;
  };
}

const file = JSON.parse(
  readFileSync(new URL("../../conformance/vectors/field-rules-vectors.json", import.meta.url), "utf8"),
) as { vectors: Vec[] };

/** Comparison rules from the file's `_comment`: JSON bodies parsed, form bodies as param maps, opaque as strings. */
function expectBody(actual: string, expected: unknown, ct: string): void {
  if (typeof expected === "string") {
    expect(actual).toBe(expected);
  } else if (normaliseContentType(ct) === "application/x-www-form-urlencoded") {
    expect(Object.fromEntries(parseQs(actual))).toEqual(expected);
  } else {
    expect(JSON.parse(actual)).toEqual(expected);
  }
}

describe("field-rules-vectors (shared with the browser masker)", () => {
  it.each(file.vectors.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const compiled = compileFieldRules(toJsonValue(v.field_rules));
    const i = v.input;
    const [body, headers, query] = applyFieldRules(i.body, i.headers, i.query, i.content_type, compiled, { salt: null });
    const [respBody, respHeaders] = applyRespFieldRules(
      i.resp_body,
      i.resp_headers,
      i.resp_content_type,
      compiled,
      v.resp_status ?? null,
      { salt: null },
    );
    expectBody(body, v.expected.masked_body, i.content_type);
    expect(Object.fromEntries(headers)).toEqual(v.expected.masked_headers);
    expect(Object.fromEntries(parseQs(query))).toEqual(v.expected.masked_query);
    expectBody(respBody, v.expected.masked_resp_body, i.resp_content_type);
    expect(Object.fromEntries(respHeaders)).toEqual(v.expected.masked_resp_headers);
  });
});
