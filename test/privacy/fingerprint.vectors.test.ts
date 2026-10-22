import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  computeRespFingerprint,
  extractKeypaths,
  extractValuePairs,
  normaliseContentType,
  uniqueQueryNames,
} from "../../src/privacy/fingerprint.js";
import { loadVectors } from "../helpers/vectors.js";

interface In {
  body: string;
  content_type: string;
  query_string: string;
  status: number;
  value_paths?: string[];
}
interface Ex {
  content_type_normalised: string;
  key_paths: string[];
  query_names: string[];
  raw: string;
  req_fingerprint: string;
  resp_fingerprint: string;
  resp_raw: string;
  value_pairs: string[];
}

const file = loadVectors<In, Ex>("fingerprint.json");

describe("fingerprint conformance vectors", () => {
  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { body, content_type: ct, query_string: qs, status, value_paths: vp } = c.input;
    expect(normaliseContentType(ct)).toBe(c.expected.content_type_normalised);
    expect(extractKeypaths(body, ct)).toEqual(c.expected.key_paths);
    expect(uniqueQueryNames(qs)).toEqual(c.expected.query_names);
    expect(vp ? extractValuePairs(body, ct, vp) : []).toEqual(c.expected.value_pairs);
    const req = computeFingerprint(body, qs, ct, vp);
    expect(req.raw).toBe(c.expected.raw);
    expect(req.fingerprint).toBe(c.expected.req_fingerprint);
    const resp = computeRespFingerprint(status, body, qs, ct);
    expect(resp.raw).toBe(c.expected.resp_raw);
    expect(resp.fingerprint).toBe(c.expected.resp_fingerprint);
  });
});
