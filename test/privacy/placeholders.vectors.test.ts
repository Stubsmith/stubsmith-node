import { afterEach, describe, expect, it } from "vitest";
import { isJsonNumber } from "../../src/internal/json.js";
import type { JsonValue } from "../../src/internal/json.js";
import { pyFloatStr } from "../../src/internal/pyfloat.js";
import { generate, getSalt } from "../../src/privacy/placeholders.js";
import { fromTyped } from "../helpers/vectors.js";
import type { TypedScalar } from "../helpers/vectors.js";
import { loadVectors } from "../helpers/vectors.js";

interface In {
  email_domain: string | null;
  salt?: string | null;
  semantic_type: string;
  value: TypedScalar;
}
interface Ex {
  output: TypedScalar;
  salt_key_hex: string | null;
}

const file = loadVectors<In, Ex>("placeholders.json");

function toTyped(v: JsonValue): TypedScalar {
  if (typeof v === "string") return { type: "str", value: v };
  if (typeof v === "boolean") return { type: "bool", value: v };
  if (v === null) return { type: "none" };
  if (isJsonNumber(v)) return v.isFloat ? { type: "float", text: pyFloatStr(v.raw) } : { type: "int", text: v.raw === "-0" ? "0" : v.raw };
  throw new Error("container");
}

const hex = (b: Uint8Array | null): string | null => (b === null ? null : Buffer.from(b).toString("hex"));

describe("placeholders conformance vectors", () => {
  afterEach(() => {
    delete process.env["STUBSMITH_MASK_SALT"];
  });

  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const salt = c.input.salt;
    if (salt) process.env["STUBSMITH_MASK_SALT"] = salt;
    else delete process.env["STUBSMITH_MASK_SALT"];
    const key = getSalt();
    expect(hex(key)).toBe(c.expected.salt_key_hex);
    const out = generate(c.input.semantic_type, fromTyped(c.input.value), { salt: key, emailDomain: c.input.email_domain });
    expect(toTyped(out)).toEqual(c.expected.output);
  });
});
