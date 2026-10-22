import { describe, expect, it } from "vitest";
import { pyFloatRepr, pyFloatStr, pyStr } from "../../src/internal/pyfloat.js";
import { jsonNumber } from "../../src/internal/json.js";

// Expectations: python3 -c 'import json; print(repr(x), json.dumps(x))' (always equal for finite x)
const CASES: Array<[string, string]> = [
  ["1.0", "1.0"],
  ["1.5", "1.5"],
  ["0.1", "0.1"],
  ["0.30000000000000004", "0.30000000000000004"],
  ["1e16", "1e+16"],
  ["9999999999999998.0", "9999999999999998.0"],
  ["1e15", "1000000000000000.0"],
  ["123456789012345680000.0", "1.2345678901234568e+20"],
  ["1e-4", "0.0001"],
  ["9.9e-5", "9.9e-05"],
  ["1e-7", "1e-07"],
  ["5e-324", "5e-324"],
  ["1.7976931348623157e308", "1.7976931348623157e+308"],
  ["-0.0", "-0.0"],
  ["9007199254740992.0", "9007199254740992.0"],
  ["1e22", "1e+22"],
  ["1.5e300", "1.5e+300"],
  ["123.456", "123.456"],
  ["-2.5e-10", "-2.5e-10"],
  ["1e100", "1e+100"],
  ["1.2345e-5", "1.2345e-05"],
  ["1E2", "100.0"],
  ["0e0", "0.0"],
];

describe("pyFloatRepr", () => {
  it.each(CASES)("%s -> %s", (raw, expected) => {
    expect(pyFloatRepr(raw)).toBe(expected);
  });

  it("non-finite", () => {
    expect(pyFloatRepr("NaN")).toBe("NaN");
    expect(pyFloatRepr("Infinity")).toBe("Infinity");
    expect(pyFloatRepr("-Infinity")).toBe("-Infinity");
    expect(pyFloatRepr("1e999")).toBe("Infinity");
  });
});

describe("pyStr", () => {
  it("scalars", () => {
    expect(pyStr("abc")).toBe("abc");
    expect(pyStr(true)).toBe("True");
    expect(pyStr(false)).toBe("False");
    expect(pyStr(null)).toBe("None");
    expect(pyStr(jsonNumber("42"))).toBe("42");
    expect(pyStr(jsonNumber("-0"))).toBe("0");
    expect(pyStr(jsonNumber("12345678901234567890123"))).toBe("12345678901234567890123");
    expect(pyStr(jsonNumber("1.0"))).toBe("1.0");
    expect(pyStr(jsonNumber("1e100"))).toBe("1e+100");
  });

  it("str() spellings of non-finite floats (python: nan, inf, -inf)", () => {
    expect(pyStr(jsonNumber("NaN"))).toBe("nan");
    expect(pyStr(jsonNumber("-Infinity"))).toBe("-inf");
    expect(pyFloatStr("Infinity")).toBe("inf");
  });

  it("rejects containers", () => {
    expect(() => pyStr([])).toThrow(TypeError);
  });
});
