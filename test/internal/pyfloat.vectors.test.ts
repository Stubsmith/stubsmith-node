import { describe, expect, it } from "vitest";
import { stringifyJson } from "../../src/internal/json.js";
import { pyFloatRepr, pyFloatStr, pyStr } from "../../src/internal/pyfloat.js";
import { fromTyped, floatToken } from "../helpers/vectors.js";
import type { TypedScalar } from "../helpers/vectors.js";
import { loadVectors } from "../helpers/vectors.js";

const file = loadVectors<{ value: TypedScalar }, { json_dumps: string; repr: string; str: string }>("pyfloat.json");

describe("pyfloat conformance vectors", () => {
  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const v = c.input.value;
    const node = fromTyped(v);
    expect(stringifyJson(node)).toBe(c.expected.json_dumps);
    expect(pyStr(node)).toBe(c.expected.str);
    if (v.type === "float") {
      expect(pyFloatRepr(floatToken(v.text))).toBe(c.expected.json_dumps);
      expect(pyFloatStr(floatToken(v.text))).toBe(c.expected.repr);
    } else if (v.type === "int") {
      expect(pyStr(node)).toBe(c.expected.repr);
    }
  });
});
