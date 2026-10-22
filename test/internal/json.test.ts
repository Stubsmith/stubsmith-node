import { describe, expect, it } from "vitest";
import {
  isJsonNumber,
  isJsonObject,
  jsonNumber,
  parseJson,
  stringifyJson,
  toPlain,
  type JsonValue,
} from "../../src/internal/json.js";

describe("parseJson", () => {
  it("keeps number tokens and int/float distinction", () => {
    const v = parseJson('[1, 1.0, 1e5, 1E5, -0, 12345678901234567890, 0.5, -1.5e-3]') as JsonValue[];
    const flags = v.map((x) => (isJsonNumber(x) ? x.isFloat : null));
    expect(flags).toEqual([false, true, true, true, false, false, true, true]);
    expect((v[5] as { raw: string }).raw).toBe("12345678901234567890");
    expect((v[1] as { value: number }).value).toBe(1);
  });

  it("accepts NaN / Infinity / -Infinity as floats", () => {
    const v = parseJson("[NaN, Infinity, -Infinity]") as JsonValue[];
    expect(v.map((x) => isJsonNumber(x) && x.isFloat)).toEqual([true, true, true]);
    expect(v.map((x) => isJsonNumber(x) && x.raw)).toEqual(["NaN", "Infinity", "-Infinity"]);
    expect(Number.isNaN((v[0] as { value: number }).value)).toBe(true);
  });

  it("objects: insertion order, last duplicate wins, __proto__ is data", () => {
    const v = parseJson('{"b": 1, "a": 2, "b": 3, "__proto__": {"x": 1}}');
    expect(isJsonObject(v)).toBe(true);
    const m = v as Map<string, JsonValue>;
    expect([...m.keys()]).toEqual(["b", "a", "__proto__"]);
    expect((m.get("b") as { raw: string }).raw).toBe("3");
    expect(isJsonObject(m.get("__proto__"))).toBe(true);
  });

  it("scalars, whitespace, escapes", () => {
    expect(parseJson(" \t\n\r true ")).toBe(true);
    expect(parseJson("null")).toBeNull();
    expect(parseJson('"a\\u00e9\\ud83d\\ude00\\n\\/"')).toBe("aé😀\n/");
    expect(parseJson('"\\ud800"')).toBe("\ud800"); // lone surrogate accepted, like Python
    expect(parseJson("[]")).toEqual([]);
    expect((parseJson("{}") as Map<string, JsonValue>).size).toBe(0);
  });

  it.each([
    "",
    " ",
    "{",
    "[1,]",
    '{"a":1,}',
    "{a:1}",
    "'a'",
    "01",
    "1.",
    ".5",
    "+1",
    "-",
    "1 2",
    "[1] x",
    "nul",
    "NaNx",
    "nan",
    '"a\nb"',
    '"\\x"',
    '"\\u12"',
    '"abc',
    "\ufeff1",
    "\u00a01",
    "[1 2]",
    '{"a" 1}',
  ])("rejects %j", (text) => {
    expect(() => parseJson(text)).toThrow(SyntaxError);
  });

  it("rejects absurd nesting with SyntaxError", () => {
    expect(() => parseJson("[".repeat(5000))).toThrow(SyntaxError);
  });
});

describe("stringifyJson", () => {
  // python3 -c 'import json; print(json.dumps({"a":"é😀\x7f\x01\"\\/\n","b":[1,1.0,1e100,-0,True,None,float("nan")],"a":2}))'
  it("matches Python json.dumps layout", () => {
    const v = parseJson('{"a":"é😀\\u007f\\u0001\\"\\\\/\\n","b":[1,1.0,1e100,-0,true,null,NaN],"a":2}');
    expect(stringifyJson(v)).toBe('{"a": 2, "b": [1, 1.0, 1e+100, 0, true, null, NaN]}');
  });

  // python3 -c 'import json; print(json.dumps("é😀\x7f\x01\"\\/\n\u2028"))'
  it("ensure_ascii escaping", () => {
    expect(stringifyJson("é😀\x7f\x01\"\\/\n\u2028")).toBe('"\\u00e9\\ud83d\\ude00\\u007f\\u0001\\"\\\\/\\n\\u2028"');
  });

  it("empty containers and nesting", () => {
    expect(stringifyJson(parseJson('{"a":[],"b":{},"c":[[1],{"d":null}]}'))).toBe(
      '{"a": [], "b": {}, "c": [[1], {"d": null}]}',
    );
  });

  it("round-trips big ints verbatim", () => {
    expect(stringifyJson(parseJson("[123456789012345678901234567890]"))).toBe("[123456789012345678901234567890]");
  });
});

describe("toPlain", () => {
  it("converts to ordinary values", () => {
    const v = parseJson('{"a":[1,2.5,"x",null,true],"__proto__":1}');
    const p = toPlain(v) as Record<string, unknown>;
    expect(p.a).toEqual([1, 2.5, "x", null, true]);
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    expect(Object.keys(p)).toEqual(["a", "__proto__"]);
  });

  it("jsonNumber derives flags", () => {
    expect(jsonNumber("2").isFloat).toBe(false);
    expect(jsonNumber("2e0").isFloat).toBe(true);
  });

  // python3 -c 'import json; json.loads("1"*4300)' -> ok (int)
  // python3 -c 'import json; json.loads("1"*4301)' -> ValueError: Exceeds the limit (4300 digits)
  it("applies Python's 4300-digit integer limit", () => {
    expect(isJsonNumber(parseJson("1".repeat(4300)))).toBe(true);
    expect(isJsonNumber(parseJson("-" + "1".repeat(4300)))).toBe(true);
    expect(() => parseJson("1".repeat(4301))).toThrow(SyntaxError);
    expect(() => parseJson("-" + "1".repeat(4301))).toThrow(SyntaxError);
    expect(() => parseJson("[" + "1".repeat(4301) + "]")).toThrow(SyntaxError);
    // python3: json.loads("1"*4301 + ".0") and json.loads("1" + "0"*5000 + "e0") parse as floats
    expect(isJsonNumber(parseJson("1".repeat(4301) + ".0"))).toBe(true);
    expect(isJsonNumber(parseJson("1" + "0".repeat(5000) + "e0"))).toBe(true);
  });
});
