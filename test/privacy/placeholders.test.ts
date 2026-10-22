import { afterEach, describe, expect, it } from "vitest";
import { isJsonNumber, jsonNumber } from "../../src/internal/json.js";
import type { JsonValue } from "../../src/internal/json.js";
import { applyFieldRules, applyRespFieldRules, compileFieldRules } from "../../src/privacy/fieldRules.js";
import { DEFAULT_EMAIL_DOMAIN, generate, getSalt } from "../../src/privacy/placeholders.js";

const SALT = new TextEncoder().encode("test-salt-value-1234");
const JSON_CT = "application/json";
const int = (n: number): JsonValue => jsonNumber(String(n));
const float = (token: string): JsonValue => jsonNumber(token);

afterEach(() => {
  delete process.env["STUBSMITH_MASK_SALT"];
});

function ibanValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = "";
  for (const c of rearranged) numeric += c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
  return BigInt(numeric) % 97n === 1n;
}

/** `value == x` for a generated placeholder: number nodes compare by their numeric value. */
const plainValue = (v: JsonValue): unknown => (isJsonNumber(v) ? v.value : v);

describe("determinism", () => {
  it.each<[string, JsonValue]>([
    ["email", "alice@example.com"],
    ["uuid", "any-string"],
    ["iso8601", "2024-01-01T00:00:00Z"],
    ["e164", "+12025550100"],
    ["iban", "DE44500105175407324931"],
    ["url", "https://example.com/path"],
    ["decimal_amount", "99.99"],
    ["decimal_amount", float("99.99")],
    ["decimal_amount", int(100)],
    ["integer_id", int(42)],
    ["opaque_token", "tok_abc123"],
    ["free_text", "Hello, World!"],
  ])("gives the same output on repeated calls (%s, %j)", (semType, value) => {
    const first = generate(semType, value, { salt: SALT });
    const second = generate(semType, value, { salt: SALT });
    expect(first).toEqual(second);
  });

  it("gives different outputs for different salts", () => {
    const outA = generate("email", "user@example.com", { salt: new TextEncoder().encode("salt-aaaa") });
    const outB = generate("email", "user@example.com", { salt: new TextEncoder().encode("salt-bbbb") });
    expect(outA).not.toEqual(outB);
  });
});

describe("uniqueness", () => {
  it.each(["email", "uuid", "iso8601", "e164", "iban", "url", "opaque_token", "free_text"])(
    "gives different outputs for different string values (%s)",
    (semType) => {
      const out1 = generate(semType, "value-one", { salt: SALT });
      const out2 = generate(semType, "value-two", { salt: SALT });
      expect(out1).not.toEqual(out2);
    },
  );

  it("gives different outputs for different integer ids", () => {
    expect(generate("integer_id", int(1), { salt: SALT })).not.toEqual(generate("integer_id", int(2), { salt: SALT }));
  });

  it("gives different outputs for different decimal amounts", () => {
    expect(generate("decimal_amount", int(1), { salt: SALT })).not.toEqual(generate("decimal_amount", int(2), { salt: SALT }));
  });
});

describe("referential integrity", () => {
  it("gives the same placeholder for the same email at two paths", () => {
    const prodEmail = "alice@prod.example.com";
    expect(generate("email", prodEmail, { salt: SALT })).toEqual(generate("email", prodEmail, { salt: SALT }));
  });

  it("gives the same placeholder for the same UUID at two paths", () => {
    const prodId = "550e8400-e29b-41d4-a716-446655440000";
    expect(generate("uuid", prodId, { salt: SALT })).toEqual(generate("uuid", prodId, { salt: SALT }));
  });

  it("keeps two different emails distinct", () => {
    expect(generate("email", "alice@example.com", { salt: SALT })).not.toEqual(generate("email", "bob@example.com", { salt: SALT }));
  });
});

describe("format validity", () => {
  it("gives a parseable email", () => {
    const out = generate("email", "user@example.com", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    expect(out).toContain("@");
    const [local, domain] = [out.slice(0, out.indexOf("@")), out.slice(out.indexOf("@") + 1)];
    expect(local).not.toBe("");
    expect(domain).not.toBe("");
  });

  it("uses the default domain when none is given", () => {
    const out = generate("email", "user@example.com", { salt: SALT }) as string;
    expect(out.endsWith(`@${DEFAULT_EMAIL_DOMAIN}`)).toBe(true);
  });

  it("uses the configured domain", () => {
    const out = generate("email", "user@example.com", { salt: SALT, emailDomain: "acme.stub.invalid" }) as string;
    expect(out.endsWith("@acme.stub.invalid")).toBe(true);
  });

  it("gives a valid version 4 UUID", () => {
    const out = generate("uuid", "original-value", { salt: SALT }) as string;
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("gives a parseable ISO 8601 timestamp", () => {
    const out = generate("iso8601", "2024-01-01T00:00:00Z", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(Number.isNaN(Date.parse(out))).toBe(false);
  });

  it("keeps the ISO 8601 components in range", () => {
    const out = generate("iso8601", "anything", { salt: SALT }) as string;
    const [datePart, rest] = out.split("T") as [string, string];
    const timePart = rest.slice(0, -6);
    expect(out.endsWith("+00:00")).toBe(true);
    const [year, month, day] = datePart.split("-").map(Number) as [number, number, number];
    const [hour, minute, second] = timePart.split(":").map(Number) as [number, number, number];
    expect(year).toBeGreaterThanOrEqual(2000);
    expect(year).toBeLessThanOrEqual(2023);
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(28);
    expect(hour).toBeLessThanOrEqual(23);
    expect(minute).toBeLessThanOrEqual(59);
    expect(second).toBeLessThanOrEqual(59);
  });

  it("gives an E.164 number: + then digits", () => {
    const out = generate("e164", "+447700900123", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    expect(out.startsWith("+")).toBe(true);
    expect(out.slice(1)).toMatch(/^\d+$/);
    expect(out.length).toBeGreaterThanOrEqual(7);
  });

  it("gives an IBAN that passes mod-97", () => {
    const out = generate("iban", "GB29NWBK60161331926819", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    expect(ibanValid(out), `IBAN mod-97 check failed for ${out}`).toBe(true);
  });

  // The generator is private and takes hash bytes, so inputs are searched for one whose check digits are 98.
  it("emits check digits 98 where the check is 98, and the IBAN is valid", () => {
    let found: string | null = null;
    for (let i = 0; i < 5000 && found === null; i++) {
      const out = generate("iban", `account-${i}`, { salt: SALT });
      if (typeof out === "string" && out.startsWith("NL98")) found = out;
    }
    expect(found).not.toBeNull();
    expect(ibanValid(found as string)).toBe(true);
  });

  it("keeps mod-97 valid across 200 inputs", () => {
    for (let i = 0; i < 200; i++) {
      const value = `account-${i}`;
      const out = generate("iban", value, { salt: SALT }) as string;
      expect(ibanValid(out), `IBAN mod-97 check failed for input ${value}: ${out}`).toBe(true);
    }
  });

  it("starts an IBAN with NL", () => {
    expect((generate("iban", "some-account", { salt: SALT }) as string).startsWith("NL")).toBe(true);
  });

  it("gives an https URL with a host", () => {
    const out = generate("url", "https://example.com/api/v1/users", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    const parsed = new URL(out);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.host).not.toBe("");
  });

  it("keeps a decimal amount from a string a numeric string", () => {
    const out = generate("decimal_amount", "12.99", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    expect(Number.isFinite(Number(out))).toBe(true);
  });

  it("keeps a decimal amount from a float a positive float", () => {
    const out = generate("decimal_amount", float("12.99"), { salt: SALT });
    expect(isJsonNumber(out) && out.isFloat).toBe(true);
    expect(isJsonNumber(out) && out.value > 0).toBe(true);
  });

  it("keeps a decimal amount from an int a positive int", () => {
    const out = generate("decimal_amount", int(100), { salt: SALT });
    expect(isJsonNumber(out) && !out.isFloat).toBe(true);
    expect(isJsonNumber(out) && out.value > 0).toBe(true);
  });

  it("gives an integer id as a positive int", () => {
    const out = generate("integer_id", int(42), { salt: SALT });
    expect(isJsonNumber(out) && !out.isFloat).toBe(true);
    expect(isJsonNumber(out) && out.value > 0).toBe(true);
  });

  it("gives an opaque token as a non-empty string", () => {
    const out = generate("opaque_token", "tok_abc123xyz", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("gives free text as a non-empty string", () => {
    const out = generate("free_text", "Hello World", { salt: SALT }) as string;
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("salt absent", () => {
  it.each<[string, JsonValue, JsonValue]>([
    ["email", "user@example.com", "<masked>"],
    ["uuid", "some-uuid", "<masked>"],
    ["iso8601", "2024-01-01", "<masked>"],
    ["e164", "+1234567890", "<masked>"],
    ["iban", "GB29NWBK...", "<masked>"],
    ["url", "https://x.com", "<masked>"],
    ["opaque_token", "tok_abc", "<masked>"],
    ["free_text", "anything", "<masked>"],
    ["integer_id", int(123), int(0)],
    ["decimal_amount", float("9.99"), int(0)],
    ["decimal_amount", int(9), int(0)],
    ["decimal_amount", "9.99", "<masked>"],
    ["currency_code", "USD", "<masked>"],
    ["country_code", "US", "<masked>"],
  ])("gives the constant when the salt is none (%s, %j)", (semType, value, expected) => {
    const out = generate(semType, value, { salt: null });
    expect(plainValue(out)).toEqual(plainValue(expected));
  });

  it("always gives false for a bool", () => {
    expect(generate("free_text", true, { salt: null })).toBe(false);
    expect(generate("email", true, { salt: SALT })).toBe(false);
  });

  it("keeps null as null", () => {
    expect(generate("email", null, { salt: null })).toBeNull();
    expect(generate("email", null, { salt: SALT })).toBeNull();
  });

  it("has no salt when the environment variable is absent", () => {
    delete process.env["STUBSMITH_MASK_SALT"];
    expect(getSalt()).toBeNull();
  });

  it("reads the salt as the bytes of the environment variable", () => {
    process.env["STUBSMITH_MASK_SALT"] = "mysecret";
    expect(getSalt()).toEqual(new TextEncoder().encode("mysecret"));
  });

  it("cuts a long salt to 64 bytes", () => {
    process.env["STUBSMITH_MASK_SALT"] = "x".repeat(200);
    expect(getSalt()?.length).toBe(64);
  });
});

describe("low cardinality", () => {
  it.each([
    ["currency_code", "USD"],
    ["currency_code", "EUR"],
    ["country_code", "US"],
    ["country_code", "DE"],
  ])("returns the constant for %s %s", (semType, value) => {
    expect(generate(semType, value, { salt: SALT })).toBe("<masked>");
  });

  it("gives false for a bool with a salt", () => {
    expect(generate("email", true, { salt: SALT })).toBe(false);
    expect(generate("uuid", false, { salt: SALT })).toBe(false);
  });

  it("gives false for a bool without a salt", () => {
    expect(generate("free_text", true, { salt: null })).toBe(false);
  });
});

describe("hint mismatch", () => {
  it("gives a digit string for an integer_id hint on a string", () => {
    const out = generate("integer_id", "42", { salt: SALT });
    expect(typeof out).toBe("string");
    expect(out as string).toMatch(/^-?\d+$/);
  });

  it("keeps the JSON type of an integer_id hint", () => {
    const outStr = generate("integer_id", "7", { salt: SALT });
    const outInt = generate("integer_id", int(7), { salt: SALT });
    expect(typeof outStr).toBe("string");
    expect(isJsonNumber(outInt) && !outInt.isFloat).toBe(true);
  });

  it("gives 0 for an integer_id hint on a float", () => {
    expect(plainValue(generate("integer_id", float("3.14"), { salt: SALT }))).toBe(0);
  });

  it.each<[string, JsonValue]>([
    ["iso8601", int(1234567890)],
    ["uuid", int(42)],
    ["email", int(100)],
    ["email", float("3.14")],
    ["url", int(999)],
    ["iban", int(42)],
    ["opaque_token", int(55)],
    ["free_text", int(42)],
  ])("gives 0 for a %s hint on %j", (semType, value) => {
    expect(plainValue(generate(semType, value, { salt: SALT }))).toBe(0);
  });

  it("gives false for a decimal_amount hint on a bool", () => {
    expect(generate("decimal_amount", true, { salt: SALT })).toBe(false);
  });
});

describe("email domain", () => {
  it("uses stub.invalid by default", () => {
    const out = generate("email", "user@real.com", { salt: SALT }) as string;
    expect(out.endsWith(`@${DEFAULT_EMAIL_DOMAIN}`)).toBe(true);
    expect(DEFAULT_EMAIL_DOMAIN).toBe("stub.invalid");
  });

  it("applies a custom domain", () => {
    const out = generate("email", "user@real.com", { salt: SALT, emailDomain: "acme.stub.invalid" }) as string;
    expect(out.endsWith("@acme.stub.invalid")).toBe(true);
  });

  it("falls back to the default when the domain is null", () => {
    const out = generate("email", "user@real.com", { salt: SALT, emailDomain: null }) as string;
    expect(out.endsWith(`@${DEFAULT_EMAIL_DOMAIN}`)).toBe(true);
  });

  it("gives different addresses for different domains", () => {
    const a = generate("email", "user@real.com", { salt: SALT, emailDomain: "a.stub.invalid" });
    const b = generate("email", "user@real.com", { salt: SALT, emailDomain: "b.stub.invalid" });
    expect(a).not.toEqual(b);
  });
});

describe("field rules integration", () => {
  const makeRules = (path: string, semType: string) => compileFieldRules([{ path, action: "mask", type: semType }]);

  it("gives an email placeholder in a JSON body", () => {
    const rules = makeRules("body.email", "email");
    process.env["STUBSMITH_MASK_SALT"] = "integration-salt";
    const [out] = applyFieldRules(JSON.stringify({ email: "alice@example.com" }), {}, "", JSON_CT, rules);
    const emailVal = (JSON.parse(out) as { email: string }).email;
    expect(typeof emailVal).toBe("string");
    expect(emailVal).toContain("@");
    expect(emailVal.endsWith(`@${DEFAULT_EMAIL_DOMAIN}`)).toBe(true);
  });

  it("uses the email domain passed in", () => {
    const rules = makeRules("body.email", "email");
    process.env["STUBSMITH_MASK_SALT"] = "integration-salt";
    const [out] = applyFieldRules(JSON.stringify({ email: "alice@example.com" }), {}, "", JSON_CT, rules, {
      emailDomain: "proj.stub.invalid",
    });
    expect((JSON.parse(out) as { email: string }).email.endsWith("@proj.stub.invalid")).toBe(true);
  });

  it("gives a version 4 UUID in a body for a uuid hint", () => {
    const rules = makeRules("body.request_id", "uuid");
    process.env["STUBSMITH_MASK_SALT"] = "integration-salt";
    const [out] = applyFieldRules(JSON.stringify({ request_id: "550e8400-e29b-41d4-a716-446655440000" }), {}, "", JSON_CT, rules);
    expect((JSON.parse(out) as { request_id: string }).request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("gives the constant <masked> for a type hint without a salt", () => {
    const rules = makeRules("body.email", "email");
    delete process.env["STUBSMITH_MASK_SALT"];
    const [out] = applyFieldRules(JSON.stringify({ email: "alice@example.com" }), {}, "", JSON_CT, rules);
    expect((JSON.parse(out) as { email: string }).email).toBe("<masked>");
  });

  it("keeps an integer_id hint on a string field a digit string", () => {
    const rules = makeRules("body.id", "integer_id");
    process.env["STUBSMITH_MASK_SALT"] = "integration-salt";
    const [out] = applyFieldRules(JSON.stringify({ id: "ch_3Nk..." }), {}, "", JSON_CT, rules);
    const id = (JSON.parse(out) as { id: unknown }).id;
    expect(typeof id).toBe("string");
    expect(id as string).toMatch(/^-?\d+$/);
  });

  it("gives an ISO 8601 placeholder in a response body for an iso8601 hint", () => {
    const rules = compileFieldRules([{ path: "resp.created_at", action: "mask", type: "iso8601" }]);
    process.env["STUBSMITH_MASK_SALT"] = "integration-salt";
    const [out] = applyRespFieldRules(JSON.stringify({ created_at: "2023-06-01T12:00:00Z" }), {}, JSON_CT, rules, undefined);
    const val = (JSON.parse(out) as { created_at: string }).created_at;
    expect(typeof val).toBe("string");
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(Number.isNaN(Date.parse(val))).toBe(false);
  });

  it("gives the same placeholder for two masking calls", () => {
    const rules = makeRules("body.user_id", "opaque_token");
    process.env["STUBSMITH_MASK_SALT"] = "stable-salt";
    const body = JSON.stringify({ user_id: "usr_abc123" });
    const [out1] = applyFieldRules(body, {}, "", JSON_CT, rules);
    const [out2] = applyFieldRules(body, {}, "", JSON_CT, rules);
    expect((JSON.parse(out1) as { user_id: string }).user_id).toBe((JSON.parse(out2) as { user_id: string }).user_id);
  });

  it("gives the constant for a mask rule with no type even with a salt", () => {
    const rules = compileFieldRules([{ path: "body.secret", action: "mask" }]);
    process.env["STUBSMITH_MASK_SALT"] = "any-salt";
    const [out] = applyFieldRules(JSON.stringify({ secret: "super-secret-value" }), {}, "", JSON_CT, rules);
    expect((JSON.parse(out) as { secret: string }).secret).toBe("<masked>");
  });

  it("carries the type hint of a status-scoped resp mask rule", () => {
    const rules = compileFieldRules([{ path: "resp:200.created_at", action: "mask", type: "iso8601" }]);
    expect(rules.respMaskTypes.has("created_at")).toBe(true);
    expect(rules.respMaskTypes.get("created_at")).toBe("iso8601");
    process.env["STUBSMITH_MASK_SALT"] = "integration-salt";
    const [out] = applyRespFieldRules(JSON.stringify({ created_at: "2023-06-01T12:00:00Z" }), {}, JSON_CT, rules, 200);
    const val = (JSON.parse(out) as { created_at: string }).created_at;
    expect(typeof val).toBe("string");
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(Number.isNaN(Date.parse(val))).toBe(false);
  });
});
