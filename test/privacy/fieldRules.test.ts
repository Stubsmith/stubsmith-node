import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFieldRules, applyRespFieldRules, compileFieldRules } from "../../src/privacy/fieldRules.js";
import { MAX_REGEX_SCAN_CHARS, compileRules, resetMaskingWarningsForTests } from "../../src/privacy/masking.js";
import { extractKeypaths } from "../../src/privacy/fingerprint.js";
import { generate } from "../../src/privacy/placeholders.js";
import { toJsonValue } from "../helpers/vectors.js";

const JSON_CT = "application/json";
const FORM_CT = "application/x-www-form-urlencoded";
const SALT = new TextEncoder().encode("test-salt");
const opts = { salt: null };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  resetMaskingWarningsForTests();
});

function resp(path: string, body: string, status: number): string {
  const compiled = compileFieldRules([{ path, action: "keep" }]);
  return applyRespFieldRules(body, {}, JSON_CT, compiled, status, opts)[0];
}

describe("compileFieldRules input handling", () => {
  it("treats a null rule list as empty", () => {
    expect(compileFieldRules(null).keepBody.size).toBe(0);
  });

  it("skips entries that are not objects and still applies the valid ones", () => {
    const rules = compileFieldRules(["not-a-dict", null, { path: "body.ok", action: "keep" }]);
    expect(rules.keepBody.has("ok")).toBe(true);
  });
});

describe("keep and mask on the same scoped header", () => {
  it("masks the header when resp_header:200.x-custom is both kept and masked", () => {
    const rules = compileFieldRules([
      { path: "resp_header:200.x-custom", action: "keep" },
      { path: "resp_header:200.x-custom", action: "mask" },
    ]);
    const [, headers] = applyRespFieldRules("", { "x-custom": "val", "content-type": "application/json" }, "", rules, 200, opts);
    expect(headers.get("x-custom")).toBe("<masked>");
  });
});

describe("scalar array keep rules", () => {
  it("lets a keep rule on items.[] keep scalar array elements through masking", () => {
    const body = JSON.stringify({ items: [1, 2, 3], secret: "hide-me" });
    const rules = compileFieldRules([{ path: "body.items.[]", action: "keep" }]);
    // key_paths includes "items.[]", so the keep rule is discoverable.
    expect(extractKeypaths(body)).toContain("items.[]");
    const [masked] = applyFieldRules(body, {}, "", JSON_CT, rules);
    const parsed = JSON.parse(masked) as { items: number[]; secret: string };
    expect(parsed.items).toEqual([1, 2, 3]);
    expect(parsed.secret).toBe("<masked>");
  });
});

describe("a free-text form body", () => {
  const text = "Dear SECRET, your PIN is 1234";

  it("is masked whole by field rules, even with a keep", () => {
    const rules = compileFieldRules([
      { path: "body.a", action: "keep" },
      { path: "body.Dear SECRET", action: "keep" },
      { path: "resp.a", action: "keep" },
    ]);
    const [mb] = applyFieldRules("a=1&Dear SECRET", {}, "", FORM_CT, rules);
    expect(mb).toBe("<masked>");
    const [rb] = applyRespFieldRules(text, {}, FORM_CT, rules, 200);
    expect(rb).toBe("<masked>");
  });
});

describe("array elements are all walked", () => {
  it("lets a keep rule reach every reported path in a mixed array, without leaking siblings", () => {
    const body = JSON.stringify({
      rows: [1, { deep: { deeper: "SECRET" } }],
      later: [null, { late: "ALSO" }],
    });
    for (const [path, token, other] of [
      ["rows.[].deep.deeper", "SECRET", "ALSO"],
      ["later.[].late", "ALSO", "SECRET"],
    ] as const) {
      expect(extractKeypaths(body)).toContain(path);
      const [out] = applyFieldRules(body, {}, "", JSON_CT, compileFieldRules([{ path: `body.${path}`, action: "keep" }]), opts);
      expect(out).toContain(token);
      expect(out).not.toContain(other);
    }
  });
});

describe("status-scoped keep rules (parseStatusSuffix)", () => {
  // Each malformed scope is ignored, so the field stays masked even at the status it names.
  it.each([
    ["resp:600.x", 600],
    ["resp:099.x", 99],
    ["resp:99.x", 99],
    ["resp:0404.x", 404],
    ["resp:2xx.x", 200],
    ["resp:404", 404],
    ["resp:٤٠٤.x", 404],
  ])("%s is ignored and the field stays masked", (path, status) => {
    expect(resp(path, '{"x":"v"}', status)).toBe('{"x": "<masked>"}');
  });

  it("resp:404. (empty subpath) keeps nothing, not even a top-level scalar", () => {
    expect(resp("resp:404.", '"v"', 404)).toBe('"<masked>"');
  });

  it.each([
    ["resp:100.x", 100],
    ["resp:599.x", 599],
    ["resp:404.x", 404],
  ])("%s keeps the field at that status and masks it at others", (path, status) => {
    expect(resp(path, '{"x":"v"}', status)).toBe('{"x": "v"}');
    expect(resp(path, '{"x":"v"}', status === 100 ? 101 : status - 1)).toBe('{"x": "<masked>"}');
    expect(resp(path, '{"x":"v"}', 200 === status ? 201 : 200)).toBe('{"x": "<masked>"}');
  });

  it("applies the same parser to resp_header scopes", () => {
    const run = (path: string, status: number): string => {
      const c = compileFieldRules([{ path, action: "keep" }]);
      return applyRespFieldRules("", { "X-A": "v" }, JSON_CT, c, status, opts)[1].get("X-A") as string;
    };
    expect(run("resp_header:600.x-a", 600)).toBe("<masked>");
    expect(run("resp_header:0404.x-a", 404)).toBe("<masked>");
    expect(run("resp_header:404.x-a", 404)).toBe("v");
  });
});

describe("keep rules are case-sensitive for form and query names", () => {
  it("a form keep on a does not keep A", () => {
    const c = compileFieldRules([{ path: "body.a", action: "keep" }]);
    expect(applyFieldRules("a=1&A=2", {}, "", FORM_CT, c, opts)[0]).toBe("a=1&A=%3Cmasked%3E");
  });
  it("a query keep on a does not keep A", () => {
    const c = compileFieldRules([{ path: "query.a", action: "keep" }]);
    expect(applyFieldRules("", {}, "a=1&A=2", JSON_CT, c, opts)[2]).toBe("a=1&A=%3Cmasked%3E");
  });
});

describe("type hints", () => {
  const body = '{"a":"secret"}';
  const run = (hint: unknown, salt: Uint8Array | null): string => {
    const c = compileFieldRules(toJsonValue([{ path: "body.a", action: "mask", type: hint }]));
    return applyFieldRules(body, {}, "", JSON_CT, c, { salt })[0];
  };

  it("a non-string scalar hint is an unknown label: free_text with a salt, the constant without", () => {
    for (const hint of [5, 1.5, true]) {
      const expected = generate("free_text", "secret", { salt: SALT });
      expect(expected).toMatch(/^text-[0-9a-f]{16}$/);
      expect(run(hint, SALT)).toBe(`{"a": "${expected as string}"}`);
      expect(run(hint, null)).toBe('{"a": "<masked>"}');
    }
  });

  it("a container hint behaves like no hint (Python's unhashable label raises into the constant)", () => {
    expect(run([1], SALT)).toBe('{"a": "<masked>"}');
    expect(run({ k: 1 }, SALT)).toBe('{"a": "<masked>"}');
  });

  it("a false, zero or empty hint is no hint", () => {
    for (const hint of [0, false, ""]) expect(run(hint, SALT)).toBe('{"a": "<masked>"}');
  });
});

describe("no built-in patterns", () => {
  const keep = compileFieldRules([
    { path: "body.a", action: "keep" },
    { path: "query.q", action: "keep" },
    { path: "resp.a", action: "keep" },
  ]);
  const value = "ana@example.com 4111 1111 1111 1111";

  it("sends a kept email or card number as it is on every path, and masks what is not kept", () => {
    const body = JSON.stringify({ a: value, b: "ana@example.com" });
    expect(applyFieldRules(body, {}, "", JSON_CT, keep, opts)[0]).toBe(
      '{"a": "ana@example.com 4111 1111 1111 1111", "b": "<masked>"}',
    );
    expect(applyFieldRules("a=ana%40example.com&b=x", {}, "", FORM_CT, keep, opts)[0]).toBe("a=ana%40example.com&b=%3Cmasked%3E");
    expect(applyFieldRules("", {}, "q=4111111111111111&r=1", JSON_CT, keep, opts)[2]).toBe("q=4111111111111111&r=%3Cmasked%3E");
    expect(applyRespFieldRules(JSON.stringify({ a: value }), {}, JSON_CT, keep, 200, opts)[0]).toBe(
      '{"a": "ana@example.com 4111 1111 1111 1111"}',
    );
  });

  it("keeps a kept string over the scan cap when no regex mask is active", () => {
    const big = "a".repeat(MAX_REGEX_SCAN_CHARS + 1);
    expect(applyFieldRules(JSON.stringify({ a: big }), {}, "", JSON_CT, keep, opts)[0]).toBe(`{"a": "${big}"}`);
  });
});

describe("regex scan cap and unusable patterns", () => {
  const keepA = compileFieldRules([{ path: "body.a", action: "keep" }]);
  const keepQ = compileFieldRules([{ path: "query.a", action: "keep" }]);
  const json = (v: string): string => JSON.stringify({ a: v });
  // A customer email-shaped pattern: quadratic on "a-".repeat(n) without the cap.
  const emailRules = compileRules([], [{ pattern: String.raw`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`, replace: "<masked>", flags: "" }]);
  const withRegex = { salt: null, extraRules: emailRules };
  const keepAll = compileFieldRules([
    { path: "body.a", action: "keep" },
    { path: "query.a", action: "keep" },
    { path: "resp.a", action: "keep" },
  ]);
  // The kept value "a" on the JSON body, form body, query and response body, in that order.
  function runEveryPath(value: string, rules: ReturnType<typeof compileRules>): string[] {
    const enc = encodeURIComponent(value);
    const o = { salt: null, extraRules: rules };
    const [jsonBody, , query] = applyFieldRules(json(value), {}, `a=${enc}`, JSON_CT, keepAll, o);
    const [formBody] = applyFieldRules(`a=${enc}`, {}, "", FORM_CT, keepAll, o);
    const [respBody] = applyRespFieldRules(json(value), {}, JSON_CT, keepAll, 200, o);
    return [
      (JSON.parse(jsonBody) as { a: string }).a,
      new URLSearchParams(formBody).get("a") ?? "",
      new URLSearchParams(query).get("a") ?? "",
      (JSON.parse(respBody) as { a: string }).a,
    ];
  }

  it("exposes the cap", () => {
    expect(MAX_REGEX_SCAN_CHARS).toBe(65536);
  });

  it("applies the cap at exactly 65,536 characters", () => {
    const atCap = "a".repeat(MAX_REGEX_SCAN_CHARS);
    expect(applyFieldRules(json(atCap), {}, "", JSON_CT, keepA, withRegex)[0]).toBe(`{"a": "${atCap}"}`);
    expect(applyFieldRules(json(atCap + "a"), {}, "", JSON_CT, keepA, withRegex)[0]).toBe('{"a": "<masked>"}');
  });

  it("masks a kept string over the cap on every path without running a regex; exactly at the cap is kept", () => {
    const rules = compileRules([], [{ pattern: "zzz", replace: "x" }]);
    expect(runEveryPath("a".repeat(MAX_REGEX_SCAN_CHARS + 1), rules)).toEqual(["<masked>", "<masked>", "<masked>", "<masked>"]);
    const atCap = "a".repeat(MAX_REGEX_SCAN_CHARS);
    expect(runEveryPath(atCap, rules)).toEqual([atCap, atCap, atCap, atCap]);
  });

  it("keeps a benign 60k string", () => {
    const ok = "abc ".repeat(15000);
    expect(applyFieldRules(json(ok), {}, "", JSON_CT, keepA, withRegex)[0]).toBe(json(ok).replace('":"', '": "'));
  });

  it("does not stall on a quadratic input", () => {
    const t = Date.now();
    const out = applyFieldRules(json("a-".repeat(40000)), {}, "", JSON_CT, keepA, withRegex)[0];
    expect(Date.now() - t).toBeLessThan(500);
    expect(out).toBe('{"a": "<masked>"}');
  });

  it("masks every kept string on every path when a synced pattern has no JS translation", () => {
    const warn = vi.mocked(console.warn);
    const rules = compileRules([], [{ pattern: "(?i:secret)", replace: "X", flags: "" }]);
    expect(rules.unusable).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("index 0");
    compileRules([], [{ pattern: "(?i:other)", replace: "X", flags: "" }]);
    expect(warn).toHaveBeenCalledTimes(1);

    const o = { salt: null, extraRules: rules };
    expect(applyFieldRules('{"a":"hello"}', {}, "", JSON_CT, keepA, o)[0]).toBe('{"a": "<masked>"}');
    expect(applyFieldRules("a=hello", {}, "", FORM_CT, keepA, o)[0]).toBe("a=%3Cmasked%3E");
    expect(applyFieldRules("", {}, "a=hello", JSON_CT, keepQ, o)[2]).toBe("a=%3Cmasked%3E");
  });

  it("masks every kept string on every path when a synced pattern is unusable", () => {
    const rules = compileRules([], [{ pattern: "[[[" }]);
    expect(rules.unusable).toBe(true);
    expect(runEveryPath("hello", rules)).toEqual(["<masked>", "<masked>", "<masked>", "<masked>"]);
  });

  it("masks every kept string when a synced pattern is one Python rejects too", () => {
    const rules = compileRules([], [{ pattern: "ok", replace: "X", flags: "" }, { pattern: "bad(", replace: "X", flags: "" }]);
    expect(rules.unusable).toBe(true);
    expect(rules.regexMasks).toHaveLength(1);
    const o = { salt: null, extraRules: rules };
    expect(applyFieldRules('{"a":"hello","n":1}', {}, "", JSON_CT, keepA, o)[0]).toBe('{"a": "<masked>", "n": 0}');
  });

  it("does not flag usable patterns", () => {
    expect(compileRules([], [{ pattern: "ok", replace: "X", flags: "" }]).unusable).toBe(false);
  });
});
