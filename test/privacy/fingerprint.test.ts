import { describe, expect, it } from "vitest";
import { extractKeypaths, extractValuePairs, extractValueTypes } from "../../src/privacy/fingerprint.js";

describe("extractKeypaths", () => {
  it("excludes values", () => {
    const kp = extractKeypaths(JSON.stringify({ secret: "super_secret_value" }));
    expect(kp).toContain("secret");
    expect(kp).not.toContain("super_secret_value");
  });
});

describe("a free-text form body", () => {
  const form = "application/x-www-form-urlencoded";

  it.each(["Dear SECRET, your PIN is 1234", "a=1&Dear SECRET"])("gives no key paths, value types or value pairs (%s)", (body) => {
    expect(extractKeypaths(body, form)).toEqual([]);
    expect(extractValueTypes(body, form).size).toBe(0);
    expect(extractValuePairs(body, form, ["a", "Dear SECRET"])).toEqual([]);
  });
});
