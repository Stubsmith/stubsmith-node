import { describe, expect, it } from "vitest";
import { parseQs, urlencodeDoseq } from "../../src/internal/pyqs.js";
import { loadVectors } from "../helpers/vectors.js";

type Pairs = Array<[string, string[]]>;
interface In {
  query?: string;
  pairs?: Pairs;
}
interface Ex {
  keys?: string[];
  parse_qs?: Pairs;
  urlencode_doseq?: string;
  urlencode_doseq_masked?: string;
}

const file = loadVectors<In, Ex>("pyqs.json");

describe("pyqs conformance vectors", () => {
  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    if (c.input.pairs !== undefined) {
      expect(urlencodeDoseq(new Map(c.input.pairs))).toBe(c.expected.urlencode_doseq);
      return;
    }
    const parsed = parseQs(c.input.query as string);
    expect([...parsed]).toEqual(c.expected.parse_qs);
    expect([...parsed.keys()]).toEqual(c.expected.keys);
    expect(urlencodeDoseq(parsed)).toBe(c.expected.urlencode_doseq);
    const masked = new Map([...parsed].map(([k, v]) => [k, v.map(() => "<masked>")] as [string, string[]]));
    expect(urlencodeDoseq(masked)).toBe(c.expected.urlencode_doseq_masked);
  });
});
