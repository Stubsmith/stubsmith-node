import { describe, expect, it } from "vitest";
import { parseJson } from "../../src/internal/json.js";
import { classifyScalar, extractValueTypes } from "../../src/privacy/fingerprint.js";
import { loadVectors, plain } from "../helpers/vectors.js";

interface In {
  op: "classify_scalar" | "extract_value_types";
  json?: string;
  body?: string;
  content_type?: string;
}
interface Ex {
  label?: string | null;
  value_types?: Record<string, string>;
}

const file = loadVectors<In, Ex>("classify.json");

describe("classify conformance vectors", () => {
  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    if (c.input.op === "classify_scalar") {
      expect(classifyScalar(parseJson(c.input.json as string))).toBe(c.expected.label);
    } else {
      expect(plain(extractValueTypes(c.input.body as string, c.input.content_type))).toEqual(c.expected.value_types);
    }
  });
});
