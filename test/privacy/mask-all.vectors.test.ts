import { describe, expect, it } from "vitest";
import { maskAll } from "../../src/privacy/masking.js";
import { loadVectors } from "../helpers/vectors.js";

interface In {
  body: string;
  content_type: string;
  headers: Record<string, string>;
  query: string;
}
interface Ex {
  body: string;
  headers: Record<string, string>;
  query: string;
}

const file = loadVectors<In, Ex>("mask-all.json");

describe("mask-all conformance vectors", () => {
  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const [body, headers, query] = maskAll(c.input.body, c.input.headers, c.input.query, c.input.content_type);
    expect(body).toBe(c.expected.body);
    expect(Object.fromEntries(headers)).toEqual(c.expected.headers);
    expect(query).toBe(c.expected.query);
  });
});
