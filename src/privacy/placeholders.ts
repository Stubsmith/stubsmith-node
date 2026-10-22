/**
 * Format-preserving placeholder generation for masked field values.
 * Port of stubsmith/privacy/placeholders.py.
 *
 * `type` on a mask rule is a hint, not a mandate: it is validated against the
 * real value's runtime type before generating. Output is derived from
 * `blake2b(pyStr(value), key=salt, digest_size=16)`, so the same
 * (value, salt, label) always yields the same output. Without a salt every
 * call returns the constant placeholder.
 */
import { blake2b } from "../internal/blake2b.js";
import { isJsonNumber, jsonNumber } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { pyStr } from "../internal/pyfloat.js";
import { truncateUtf8Bytes } from "../internal/utf8.js";
import { utf8EncodeStrict } from "../internal/pystr.js";
import { VOCAB } from "./classifiers.generated.js";

/** Closed vocabulary, generated from the shared classifier spec. */
export const SEMANTIC_TYPE_VOCAB: ReadonlySet<string> = VOCAB;

/** Types whose generated output is always a string. */
const STRING_TYPES: ReadonlySet<string> = new Set([
  "email", "uuid", "iso8601", "e164", "iban", "url", "opaque_token", "free_text",
]);

/** Low-cardinality types, always refused (a keyed hash over a tiny set is a lookup table). */
const LOW_CARDINALITY: ReadonlySet<string> = new Set(["currency_code", "country_code"]);

/** Email domain used when none has been synced. */
export const DEFAULT_EMAIL_DOMAIN = "stub.invalid";

export interface GenerateOptions {
  /** BLAKE2b key bytes (see {@link getSalt}); `null` or empty means no key and the constant is returned. */
  salt: Uint8Array | null;
  /** Domain for generated emails; `null`/empty/absent means {@link DEFAULT_EMAIL_DOMAIN}. */
  emailDomain?: string | null;
}

/**
 * Placeholder for `value`, or the constant placeholder on any failure or type
 * mismatch. The output JSON type matches the input's. Never throws.
 */
export function generate(label: string, value: JsonValue, opts: GenerateOptions): JsonValue {
  try {
    return generateInner(label, value, opts.salt, opts.emailDomain ?? null);
  } catch {
    return constantFor(value);
  }
}

/**
 * `STUBSMITH_MASK_SALT` as bytes: UTF-8, first 64 bytes (the BLAKE2b key
 * limit); `null` when unset or empty. Read from the environment on every call.
 */
export function getSalt(): Uint8Array | null {
  const val = process.env["STUBSMITH_MASK_SALT"];
  if (!val) return null;
  return truncateUtf8Bytes(val, 64);
}

function generateInner(label: string, value: JsonValue, salt: Uint8Array | null, emailDomain: string | null): JsonValue {
  // Absent salt (Python: `None`; get_salt never returns an empty key).
  if (salt === null || salt.length === 0) return constantFor(value);
  if (typeof value === "boolean") return false; // low cardinality
  if (value === null) return null;
  if (LOW_CARDINALITY.has(label)) return constantFor(value);
  if (!SEMANTIC_TYPE_VOCAB.has(label)) label = "free_text";
  if (!hintMatchesType(label, value)) return constantFor(value);

  // str() normalisation is intentional: str(1) and str("1") hash identically.
  const b = blake2b(utf8EncodeStrict(pyStr(value)), { digestLength: 16, key: salt });
  const domain = emailDomain ? emailDomain : DEFAULT_EMAIL_DOMAIN;
  return dispatch(label, value, b, domain);
}

function hintMatchesType(label: string, value: JsonValue): boolean {
  if (STRING_TYPES.has(label)) return typeof value === "string";
  if (label === "integer_id") return typeof value === "string" || (isJsonNumber(value) && !value.isFloat);
  if (label === "decimal_amount") return typeof value === "string" || isJsonNumber(value);
  return true;
}

function dispatch(label: string, value: JsonValue, b: Uint8Array, emailDomain: string): JsonValue {
  switch (label) {
    case "email": return genEmail(b, emailDomain);
    case "uuid": return genUuid(b);
    case "iso8601": return genIso8601(b);
    case "e164": return genE164(b);
    case "iban": return genIban(b);
    case "url": return genUrl(b);
    case "decimal_amount": return genDecimalAmount(b, value);
    case "integer_id": return genIntegerId(b, value);
    case "opaque_token": return genOpaqueToken(b);
    default: return genFreeText(b);
  }
}

const hex = (b: Uint8Array, from: number, to: number): string =>
  Array.from(b.subarray(from, to), (x) => x.toString(16).padStart(2, "0")).join("");
const at = (b: Uint8Array, i: number): number => b[i] as number;
const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const be = (b: Uint8Array, from: number, to: number): bigint => BigInt("0x" + hex(b, from, to));

/** Eight lowercase hex characters at `domain`. */
function genEmail(b: Uint8Array, domain: string): string {
  return `${hex(b, 0, 4)}@${domain}`;
}

/** Version 4, RFC 4122 variant UUID from 16 hash bytes. */
function genUuid(b: Uint8Array): string {
  const ba = Uint8Array.from(b);
  ba[6] = (at(ba, 6) & 0x0f) | 0x40;
  ba[8] = (at(ba, 8) & 0x3f) | 0x80;
  const h = hex(ba, 0, 16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** UTC timestamp with always-valid ranges (day 1-28). */
function genIso8601(b: Uint8Array): string {
  const year = 2000 + (at(b, 0) % 24);
  const month = 1 + (at(b, 1) % 12);
  const day = 1 + (at(b, 2) % 28);
  const hour = at(b, 3) % 24;
  const minute = at(b, 4) % 60;
  const second = at(b, 5) % 60;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}+00:00`;
}

/** `+1` plus 10 digits. */
function genE164(b: Uint8Array): string {
  let digits = "";
  for (let i = 0; i < 10; i++) digits += String(at(b, i) % 10);
  return `+1${digits}`;
}

/** Netherlands-format IBAN with a correct mod-97 check. */
function genIban(b: Uint8Array): string {
  let bank = "";
  for (let i = 0; i < 4; i++) bank += String.fromCharCode(65 + (at(b, i) % 26));
  let acct = "";
  for (let i = 0; i < 10; i++) acct += String(at(b, 4 + i) % 10);
  const bban = bank + acct;
  // Rearranged: BBAN + "NL00"; letters become ord - 55 (A=10 .. Z=35).
  let numeric = "";
  for (const c of bban + "NL00") numeric += c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
  const check = 98 - Number(BigInt(numeric) % 97n);
  return `NL${pad(check, 2)}${bban}`;
}

/** HTTPS URL at the `stub.invalid` TLD. */
function genUrl(b: Uint8Array): string {
  return `https://${hex(b, 0, 4)}.stub.invalid/${hex(b, 4, 8)}`;
}

/** Non-zero decimal amount matching the real value's JSON type (str, float, int). */
function genDecimalAmount(b: Uint8Array, real: JsonValue): JsonValue {
  const intPart = Number(be(b, 0, 4) % 9999n) + 1;
  const fracPart = Number(be(b, 4, 6) % 100n);
  if (typeof real === "string") return `${intPart}.${pad(fracPart, 2)}`;
  if (isJsonNumber(real) && real.isFloat) return jsonNumber(`${intPart}.${pad(fracPart, 2)}`);
  return jsonNumber(String(intPart));
}

/** Non-zero positive integer id; a string input yields a digit string. */
function genIntegerId(b: Uint8Array, real: JsonValue): JsonValue {
  const n = (be(b, 0, 8) % 999999999n + 1n).toString();
  if (typeof real === "string") return n;
  return jsonNumber(n);
}

function genOpaqueToken(b: Uint8Array): string {
  return hex(b, 0, 16);
}

function genFreeText(b: Uint8Array): string {
  return `text-${hex(b, 0, 8)}`;
}

/** Constant placeholder for `value` (mirrors `_mask_all_values` for scalars). */
export function constantFor(value: JsonValue): JsonValue {
  if (typeof value === "boolean") return false;
  if (isJsonNumber(value)) return jsonNumber("0");
  if (typeof value === "string") return "<masked>";
  return null;
}
