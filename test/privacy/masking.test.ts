import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_ALLOWLIST, MAX_REGEX_SCAN_CHARS, applyRegexes, compileRules, maskAll, maskKnown, resetMaskingWarningsForTests } from "../../src/privacy/masking.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetMaskingWarningsForTests();
});

describe("compileRules", () => {
  it("skips invalid patterns and warns once per process naming the index", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = compileRules([], [
      { pattern: "ok-\\d+", replace: "", flags: "" },
      { pattern: "bad(", replace: "x", flags: "" },
      { pattern: "also(bad", replace: "x", flags: "" },
    ]);
    expect(rules.regexMasks).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("index 1");
  });

  it("marks the rules unusable for a regex entry with no pattern key", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(compileRules([], [{}]).unusable).toBe(true);
  });

  it("honours 'i' in flags and defaults an empty replace to <masked>", () => {
    const rules = compileRules(["  Token "], [{ pattern: "secret", replace: "", flags: "i" }]);
    expect([...rules.fieldMasks]).toEqual(["token"]);
    expect(applyRegexes("a SeCrEt b", rules)).toBe("a <masked> b");
  });

  it("expands Python replacement templates", () => {
    const rules = compileRules([], [
      { pattern: "(?P<k>\\w+)=(\\d+)", replace: "\\2:\\g<k>:\\\\:\\.", flags: "" },
    ]);
    expect(applyRegexes("a=1", rules)).toBe("1:a:\\:\\.");
  });

  it("raises for a bad escape at apply time, like re.sub", () => {
    const rules = compileRules([], [{ pattern: "a", replace: "\\q", flags: "" }]);
    expect(() => applyRegexes("a", rules)).toThrow();
  });
});

describe("maskKnown", () => {
  it("masks field names case-insensitively without recursing and runs regexes on plain text", () => {
    const rules = compileRules(["Secret"], [{ pattern: "\\d{4}", replace: "####", flags: "" }]);
    const [body, headers, query] = maskKnown(
      '{"SECRET": {"a": 1}, "n": "1234", "k": 2}',
      { Authorization: "x", "Content-Type": "application/json" },
      "SECRET=1&b=9999",
      "application/json",
      rules,
    );
    expect(body).toBe('{"SECRET": "<masked>", "n": "####", "k": 2}');
    expect(Object.fromEntries(headers)).toEqual({ Authorization: "<masked>", "Content-Type": "application/json" });
    expect(query).toBe("SECRET=%3Cmasked%3E&b=%23%23%23%23");
    expect(maskKnown("card 1234", {}, "", "text/plain", rules)[0]).toBe("card ####");
  });

  it("runs regex masks on each list element", () => {
    const rules = compileRules([], [{ pattern: "b", replace: "X", flags: "" }]);
    const [body] = maskKnown(JSON.stringify({ tags: ["a", "b", "c"] }), {}, "", "application/json", rules);
    expect(JSON.parse(body)).toEqual({ tags: ["a", "X", "c"] });
  });

  it("returns a non-JSON body with no matching regex unchanged", () => {
    const rules = compileRules([], [{ pattern: String.raw`\d{16}`, replace: "X", flags: "" }]);
    expect(maskKnown("hello world", {}, "", "text/plain", rules)[0]).toBe("hello world");
  });

  it("treats a free-text form body as text", () => {
    const rules = compileRules([], [{ pattern: String.raw`PIN is \d+`, replace: "PIN" }]);
    const [body] = maskKnown("Dear SECRET, your PIN is 1234", {}, "", "application/x-www-form-urlencoded", rules);
    expect(body).toBe("Dear SECRET, your PIN");
  });
});

describe("legacy paths: fail closed on unusable patterns and long strings", () => {
  it("masks every string when a pattern has no JS translation, in JSON, form, query and text", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = compileRules([], [{ pattern: "(?i:secret)", replace: "X", flags: "" }]);
    const [body, , query] = maskKnown('{"n":"hello","k":2}', {}, "q=hello", "application/json", rules);
    expect(body).toBe('{"n": "<masked>", "k": 2}');
    expect(query).toBe("q=%3Cmasked%3E");
    expect(maskKnown("n=hello", {}, "", "application/x-www-form-urlencoded", rules)[0]).toBe("n=%3Cmasked%3E");
    expect(maskKnown("hello", {}, "", "text/plain", rules)[0]).toBe("<masked>");
  });

  it("masks every string and keeps numbers when a pattern is invalid", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = compileRules([], [{ pattern: "[[[", replace: "x" }]);
    const [body] = maskKnown(JSON.stringify({ val: "hello", n: 1 }), {}, "", "application/json", rules);
    expect(JSON.parse(body)).toEqual({ val: "<masked>", n: 1 });
  });

  it("masks a text/plain body when a pattern is invalid", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = compileRules([], [{ pattern: "[[[" }]);
    expect(maskKnown("hello", {}, "", "text/plain", rules)[0]).toBe("<masked>");
  });

  it("scans exactly 65,536 characters and masks one more without running the regex", () => {
    const rules = compileRules([], [{ pattern: "zzz", replace: "x" }]);
    const atCap = "a".repeat(MAX_REGEX_SCAN_CHARS);
    expect(applyRegexes(atCap, rules)).toBe(atCap);
    expect(applyRegexes(atCap + "a", rules)).toBe("<masked>");
  });

  it("keeps a string over the cap when no regex is active", () => {
    const long = "a".repeat(MAX_REGEX_SCAN_CHARS + 1);
    expect(applyRegexes(long, compileRules(["f"], []))).toBe(long);
  });

  it("masks over-long strings when regexes would run, and leaves them alone when there are none", () => {
    const big = "a".repeat(MAX_REGEX_SCAN_CHARS + 1);
    const withRegex = compileRules([], [{ pattern: "zzz", replace: "", flags: "" }]);
    expect(maskKnown(JSON.stringify({ n: big }), {}, "", "application/json", withRegex)[0]).toBe('{"n": "<masked>"}');
    expect(maskKnown(big, {}, "", "text/plain", withRegex)[0]).toBe("<masked>");
    expect(maskKnown(`n=${big}`, {}, "", "application/x-www-form-urlencoded", withRegex)[0]).toBe("n=%3Cmasked%3E");
    expect(maskKnown(big, {}, `q=${big}`, "text/plain", withRegex)[2]).toBe("q=%3Cmasked%3E");
    expect(maskKnown(big, {}, "", "text/plain", compileRules(["x"], []))[0]).toBe(big);
  });
});

function parsedQs(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe("compileRules details", () => {
  it("lowercases and strips field mask names", () => {
    const rules = compileRules(["Password", "  TOKEN  "], []);
    expect(rules.fieldMasks.has("password")).toBe(true);
    expect(rules.fieldMasks.has("token")).toBe(true);
  });

  it("drops an invalid regex and marks the rules unusable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = compileRules([], [
      { pattern: "ok", replace: "x" },
      { pattern: "[invalid(", replace: "x" },
    ]);
    expect(rules.regexMasks).toHaveLength(1);
    expect(rules.unusable).toBe(true);
  });

  it("marks the rules unusable for a repeat count Python cannot represent", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(compileRules([], [{ pattern: "a{99999999999}", replace: "x" }]).unusable).toBe(true);
  });

  it.each([
    [[], [{ pattern: 5 }]],
    [[], [{ pattern: "" }]],
    [[], [{}]],
    [[], ["not an object"]],
    [[], [{ pattern: "a", replace: 5 }]],
    [[], [{ pattern: "a", flags: 5 }]],
    [[], { pattern: "a" }],
    [[1, "ok"], []],
    ["password", []],
  ])("marks the rules unusable for a malformed entry (%j, %j)", (fieldMasks, regexMasks) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(compileRules(fieldMasks, regexMasks).unusable).toBe(true);
  });

  it("drops malformed entries and keeps the valid ones", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = compileRules([1, "Secret"], [{ pattern: 5 }, { pattern: "ok", replace: "x" }]);
    expect([...rules.fieldMasks]).toEqual(["secret"]);
    expect(rules.regexMasks).toHaveLength(1);
  });

  it("does not mark valid regexes unusable", () => {
    expect(compileRules([], [{ pattern: "ok", replace: "x" }]).unusable).toBe(false);
  });

  it("warns once per process for an unusable regex and names the index", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compileRules([], [{ pattern: "ok" }, { pattern: "[[[" }]);
    compileRules([], [{ pattern: "(((" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("regex mask at index 1 cannot be used");
  });

  it("turns an empty replacement into <masked>", () => {
    const rules = compileRules([], [{ pattern: "foo", replace: "" }]);
    expect(rules.regexMasks[0]?.replace).toBe("<masked>");
  });

  it("makes the compiled regex case-insensitive for the i flag", () => {
    const rules = compileRules([], [{ pattern: "secret", flags: "i", replace: "X" }]);
    expect(rules.regexMasks[0]?.regex.flags).toContain("i");
  });
});

describe("maskKnown details", () => {
  it("replaces the value of a field mask", () => {
    const rules = compileRules(["password"], []);
    const [masked] = maskKnown(JSON.stringify({ password: "s3cr3t", user: "alice" }), {}, "", "application/json", rules);
    const obj = JSON.parse(masked) as Record<string, unknown>;
    expect(obj["password"]).toBe("<masked>");
    expect(obj["user"]).toBe("alice");
  });

  it("replaces the whole subtree of a field mask", () => {
    const rules = compileRules(["nested"], []);
    const [masked] = maskKnown(JSON.stringify({ nested: { password: "s3cr3t", inner: "x" } }), {}, "", "application/json", rules);
    expect((JSON.parse(masked) as Record<string, unknown>)["nested"]).toBe("<masked>");
  });

  it("matches field mask names in any case", () => {
    const rules = compileRules(["authorization"], []);
    const [masked] = maskKnown(JSON.stringify({ Authorization: "Bearer tok" }), {}, "", "application/json", rules);
    expect((JSON.parse(masked) as Record<string, unknown>)["Authorization"]).toBe("<masked>");
  });

  it("rewrites JSON string values with a regex mask", () => {
    const rules = compileRules([], [{ pattern: String.raw`Bearer\s+\S+`, replace: "<token>", flags: "" }]);
    const [masked] = maskKnown(JSON.stringify({ note: "Bearer abc123xyz" }), {}, "", "application/json", rules);
    expect((JSON.parse(masked) as Record<string, unknown>)["note"]).toBe("<token>");
  });

  it("applies regex masks in order, each on the previous output", () => {
    const rules = compileRules([], [
      { pattern: "hello", replace: "hi", flags: "" },
      { pattern: "hi world", replace: "greetings", flags: "" },
    ]);
    const [masked] = maskKnown(JSON.stringify({ msg: "hello world" }), {}, "", "application/json", rules);
    expect((JSON.parse(masked) as Record<string, unknown>)["msg"]).toBe("greetings");
  });

  it("honours the i flag of a regex mask", () => {
    const rules = compileRules([], [{ pattern: "secret_value", replace: "<x>", flags: "i" }]);
    const [masked] = maskKnown(JSON.stringify({ val: "SECRET_VALUE" }), {}, "", "application/json", rules);
    expect((JSON.parse(masked) as Record<string, unknown>)["val"]).toBe("<x>");
  });

  it("leaves numbers unchanged when no field mask names them", () => {
    const rules = compileRules([], []);
    const [masked] = maskKnown(JSON.stringify({ count: 42, rate: 3.14 }), {}, "", "application/json", rules);
    const obj = JSON.parse(masked) as Record<string, number>;
    expect(obj["count"]).toBe(42);
    expect(obj["rate"]).toBeCloseTo(3.14);
  });

  it("applies regex masks to a non-JSON body", () => {
    const rules = compileRules([], [{ pattern: String.raw`\b\d{16}\b`, replace: "<masked-cc>", flags: "" }]);
    const [masked] = maskKnown("card 4111111111111111 charged", {}, "", "text/plain", rules);
    expect(masked).toContain("<masked-cc>");
    expect(masked).not.toContain("4111111111111111");
  });
});

describe("header allowlist in maskKnown and maskAll", () => {
  const headers = {
    "content-type": "application/json",
    host: "example.com",
    authorization: "Bearer tok",
    "x-custom": "value",
    cookie: "session=abc",
  };
  const check = (masked: ReadonlyMap<string, string>): void => {
    expect(masked.get("content-type")).toBe("application/json");
    expect(masked.get("host")).toBe("example.com");
    expect(masked.get("authorization")).toBe("<masked>");
    expect(masked.get("x-custom")).toBe("<masked>");
    expect(masked.get("cookie")).toBe("<masked>");
  };

  it("applies in maskKnown", () => {
    const [, masked] = maskKnown("{}", headers, "", "application/json", compileRules([], []));
    check(masked);
  });

  it("applies in maskAll", () => {
    const [, masked] = maskAll("{}", headers, "", "application/json");
    check(masked);
  });

  it("keeps every allowlisted name in both", () => {
    const all = Object.fromEntries([...HEADER_ALLOWLIST].map((name) => [name, "value"]));
    const [, known] = maskKnown("{}", all, "", "", compileRules([], []));
    const [, everything] = maskAll("{}", all, "", "");
    for (const name of HEADER_ALLOWLIST) {
      expect(known.get(name), `maskKnown dropped ${name}`).toBe("value");
      expect(everything.get(name), `maskAll dropped ${name}`).toBe("value");
    }
  });
});

describe("query masking", () => {
  it("applies a field mask to query parameters in maskKnown", () => {
    const rules = compileRules(["secret"], []);
    const [, , q] = maskKnown("{}", {}, "secret=abc&safe=123", "application/json", rules);
    expect(parsedQs(q).getAll("secret")).toEqual(["<masked>"]);
    expect(parsedQs(q).getAll("safe")).toEqual(["123"]);
  });

  it("runs a regex on query values that are not field-masked", () => {
    const rules = compileRules([], [{ pattern: String.raw`\d+`, replace: "0", flags: "" }]);
    const [, , q] = maskKnown("{}", {}, "page=5&q=abc", "application/json", rules);
    expect(parsedQs(q).getAll("page")).toEqual(["0"]);
    expect(parsedQs(q).getAll("q")).toEqual(["abc"]);
  });

  it("masks every query value in maskAll", () => {
    const [, , q] = maskAll("{}", {}, "a=1&b=2", "application/json");
    expect(parsedQs(q).getAll("a")).toEqual(["<masked>"]);
    expect(parsedQs(q).getAll("b")).toEqual(["<masked>"]);
  });

  it("keeps an empty query empty", () => {
    const [, , q] = maskKnown("{}", {}, "", "application/json", compileRules([], []));
    expect(q).toBe("");
  });
});

describe("maskAll structure", () => {
  it("keeps the JSON structure and masks scalars by type", () => {
    const body = JSON.stringify({ user: { name: "Alice", age: 30 }, active: true, score: null });
    const [masked] = maskAll(body, {}, "", "application/json");
    const obj = JSON.parse(masked) as { user: Record<string, unknown>; active: unknown; score: unknown };
    expect(typeof obj.user).toBe("object");
    expect(obj.user["name"]).toBe("<masked>");
    expect(obj.user["age"]).toBe(0);
    expect(obj.active).toBe(false);
    expect(obj.score).toBeNull();
  });

  it("keeps a root array structure", () => {
    const body = JSON.stringify([
      { id: 1, val: "x" },
      { id: 2, val: "y" },
    ]);
    const [masked] = maskAll(body, {}, "", "application/json");
    const arr = JSON.parse(masked) as Array<Record<string, unknown>>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(2);
    expect(arr[0]?.["id"]).toBe(0);
    expect(arr[0]?.["val"]).toBe("<masked>");
  });

  it("turns a non-JSON body into <masked>", () => {
    expect(maskAll("not json", {}, "", "text/plain")[0]).toBe("<masked>");
  });

  it("keeps a valid form with a blank value", () => {
    expect(maskAll("a=1&b=", {}, "", "application/x-www-form-urlencoded")[0]).toBe("a=%3Cmasked%3E&b=%3Cmasked%3E");
  });

  it("keeps form field names and masks values", () => {
    const [masked] = maskAll("username=alice&password=s3cr3t", {}, "", "application/x-www-form-urlencoded");
    expect(parsedQs(masked).has("username")).toBe(true);
    expect(parsedQs(masked).has("password")).toBe(true);
    expect(parsedQs(masked).getAll("username")).toEqual(["<masked>"]);
    expect(parsedQs(masked).getAll("password")).toEqual(["<masked>"]);
  });
});
