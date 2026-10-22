import { describe, expect, it } from "vitest";
import { jsonNumber } from "../../src/internal/json.js";
import { classifyScalar, extractValueTypes } from "../../src/privacy/fingerprint.js";
import { plain } from "../helpers/vectors.js";

const int = (n: number) => jsonNumber(String(n));

describe("classifyScalar", () => {
  it.each([
    ["a lowercase UUID", "550e8400-e29b-41d4-a716-446655440000", "uuid"],
    ["an uppercase UUID", "550E8400-E29B-41D4-A716-446655440000", "uuid"],
    ["a UUID, not free_text", "f47ac10b-58cc-4372-a567-0e02b2c3d479", "uuid"],
    ["an ISO date", "2024-03-15", "iso8601"],
    ["an ISO datetime with T", "2024-03-15T12:34:56Z", "iso8601"],
    ["an ISO datetime with a space", "2024-03-15 12:34:56", "iso8601"],
    ["an email", "user@example.com", "email"],
    ["an email with a plus", "user+tag@sub.example.org", "email"],
    ["an E.164 number", "+441234567890", "e164"],
    ["an E.164 number at the 7-digit minimum", "+1234567", "e164"],
    ["a GB IBAN", "GB29NWBK60161331926819", "iban"],
    ["a DE IBAN", "DE89370400440532013000", "iban"],
    ["an https URL", "https://example.com/path?q=1", "url"],
    ["an http URL", "http://api.example.com/v1/users", "url"],
    ["currency EUR", "EUR", "currency_code"],
    ["currency USD", "USD", "currency_code"],
    ["country NL", "NL", "country_code"],
    ["country US", "US", "country_code"],
    ["three letters as currency, not country", "GBP", "currency_code"],
    ["a decimal string", "19.99", "decimal_amount"],
    ["a negative decimal string", "-5.00", "decimal_amount"],
    ["an API-key-like string as free_text", "sk_live_abc1234xyz", "free_text"],
    ["a mixed alphanumeric string as free_text", "a1b2c3d4e5", "free_text"],
    ["a Stripe-style id as free_text", "ch_3Nk9BQ2eZvKYlo2C1b2XNpO8", "free_text"],
    ["text with spaces as free_text", "hello world", "free_text"],
    ["a short word as free_text", "pending", "free_text"],
    ["a long all-letter string as free_text", "pendingpayment", "free_text"],
    ["a status word as free_text", "active", "free_text"],
    ["an integer string", "42", "integer_id"],
    ["a large integer string", "1000000", "integer_id"],
    ["the string 0", "0", "integer_id"],
    ["a negative integer string", "-5", "integer_id"],
    ["the shortest real IBAN (15 characters)", "NO9386011117947", "iban"],
    ["the longest real IBAN (31 characters)", "MT84MALT011000012345MTLCAST001S", "iban"],
    ["a UUID, not free_text (second check)", "550e8400-e29b-41d4-a716-446655440000", "uuid"],
    ["a@b.co as email", "a@b.co", "email"],
  ])("labels %s", (_name, value, label) => {
    expect(classifyScalar(value)).toBe(label);
  });

  it("does not label +12345 as e164", () => {
    expect(classifyScalar("+12345")).not.toBe("e164");
  });

  it("labels a float as decimal_amount", () => {
    expect(classifyScalar(jsonNumber("1.99"))).toBe("decimal_amount");
  });

  it("labels an int as integer_id", () => {
    expect(classifyScalar(int(42))).toBe("integer_id");
  });

  it("labels int 0", () => {
    expect(classifyScalar(int(0))).toBe("integer_id");
  });

  it("labels a large int", () => {
    expect(classifyScalar(int(9999999))).toBe("integer_id");
  });

  it("labels 42 integer_id and 42.0 decimal_amount", () => {
    expect(classifyScalar("42")).toBe("integer_id");
    expect(classifyScalar("42.0")).toBe("decimal_amount");
  });

  it.each(["EU20240001", "GB12BATCH01", "US24XLBLUE"])("does not label %s as iban", (value) => {
    expect(classifyScalar(value)).not.toBe("iban");
  });

  it("gives true, false and null no label", () => {
    expect(classifyScalar(true)).toBeNull();
    expect(classifyScalar(false)).toBeNull();
    expect(classifyScalar(null)).toBeNull();
  });

  it("gives an object and an array no label", () => {
    expect(classifyScalar(new Map([["a", int(1)]]))).toBeNull();
    expect(classifyScalar([int(1), int(2)])).toBeNull();
  });
});

describe("extractValueTypes", () => {
  const JSON_CT = "application/json";
  const types = (body: string, ct: string): Record<string, string> => plain<Record<string, string>>(extractValueTypes(body, ct));

  it("labels ints and emails in a flat JSON body and leaves out bools", () => {
    const result = types(JSON.stringify({ id: 42, email: "a@b.com", active: true }), JSON_CT);
    expect(result["id"]).toBe("integer_id");
    expect(result["email"]).toBe("email");
    expect(result).not.toHaveProperty("active");
  });

  it("uses nested object paths", () => {
    const result = types(JSON.stringify({ user: { id: 7, name: "Alice" } }), JSON_CT);
    expect(result["user.id"]).toBe("integer_id");
    expect(result["user.name"]).toBe("free_text");
  });

  it("uses [] paths for an array of objects", () => {
    // 9.99 and the sku are written as JSON text so the number keeps its float form.
    const result = types('{"items": [{"price": 9.99, "sku": "ITEM1234AB"}]}', JSON_CT);
    expect(result["items.[].price"]).toBe("decimal_amount");
    // opaque_token is not emitted by the classifier; character composition is not a format.
    expect(result["items.[].sku"]).toBe("free_text");
  });

  it("labels a scalar array", () => {
    const result = types(JSON.stringify({ tags: ["active", "pending"] }), JSON_CT);
    expect(result["tags.[]"]).toBe("free_text");
  });

  it("labels a root array", () => {
    const result = types(JSON.stringify([{ id: 1 }, { id: 2 }]), JSON_CT);
    expect(result["[].id"]).toBe("integer_id");
  });

  it("leaves out bools and nulls", () => {
    const result = types(JSON.stringify({ flag: true, missing: null, count: 5 }), JSON_CT);
    expect(result).not.toHaveProperty("flag");
    expect(result).not.toHaveProperty("missing");
    expect(result["count"]).toBe("integer_id");
  });

  it("labels a form body", () => {
    const result = types("amount=19.99&currency=EUR&note=hello+world", "application/x-www-form-urlencoded");
    expect(result["amount"]).toBe("decimal_amount");
    expect(result["currency"]).toBe("currency_code");
    expect(result["note"]).toBe("free_text");
  });

  it("gives no labels for malformed JSON", () => {
    expect(types("{not valid json}", JSON_CT)).toEqual({});
  });

  it("gives no labels for an empty body", () => {
    expect(types("", JSON_CT)).toEqual({});
  });

  it("gives no labels for a whitespace-only body", () => {
    expect(types("   ", JSON_CT)).toEqual({});
  });

  it("gives no labels for a non-JSON text/plain body", () => {
    expect(types("hello world", "text/plain")).toEqual({});
  });
});
