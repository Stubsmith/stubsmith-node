/**
 * Ingest refusal reporting. Port of `_report_ingest_refusal` and the remedy
 * table in stubsmith/client.py (lines 53-168).
 *
 * An ingest response that says `ok: false` (on a 200 or on a 4xx) used to
 * vanish because the send "succeeded". Each distinct code is now warned about
 * once per process. Only parsed error/reason/message fields and the HTTP
 * status are logged, never the API key or payload content.
 */
import { utf8Decode } from "./internal/utf8.js";
import { parseJson } from "./internal/json.js";
import type { JsonValue } from "./internal/json.js";
import { pyStr } from "./internal/pyfloat.js";
import { dictGet, pyStrip, pyTruthy } from "./internal/pystr.js";

// A Map: the code is server-controlled, and a plain object would resolve "constructor" or "__proto__" to inherited values.
const REMEDIES = new Map<string, string>(Object.entries({
  fingerprint_limit_reached:
    "New endpoint shapes are not being recorded until the plan is " +
    "upgraded or unused fingerprints are deleted in the dashboard.",
  pii_leak:
    "The capture was quarantined because a value looked like personal " +
    "data. Check the field rules and the project placeholder domain.",
  rejected: "This endpoint shape was rejected in the dashboard; nothing is recorded for it.",
  body_too_large:
    "The capture was over the size limit and was not recorded. Lower " +
    "max_payload_bytes or exclude the endpoint.",
  sdk_required: "Upgrade the stubsmith SDK to a current version.",
  "rate limit exceeded":
    "Captures are being sent faster than the plan allows; some are " +
    "dropped. Reduce traffic or sample, or upgrade the plan.",
}));
const REMEDY_DEFAULT = "Check the project in the StubSmith dashboard.";
export const INGEST_DEBUG_BODY_CHARS = 2048;
/** Bytes of an ingest response body that are read for refusal parsing. */
export const INGEST_ERROR_READ_BYTES = 64 * 1024;
export const INGEST_MAX_WARNED_CODES = 64;

const warnedCodes = new Set<string>();

/** Test hook: forget which refusal codes were already warned about. */
export function resetIngestWarningsForTests(): void {
  warnedCodes.clear();
}

/** First `n` code points (Python `s[:n]`). */
function headCodePoints(s: string, n: number): string {
  if (s.length <= n) return s;
  const out: string[] = [];
  for (const ch of s) {
    if (out.length >= n) break;
    out.push(ch);
  }
  return out.join("");
}

function reprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === q || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + q;
}

/** Python `repr()` of a parsed JSON value (approximate for exotic unicode categories in strings). */
function pyRepr(v: JsonValue): string {
  if (typeof v === "string") return reprStr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${reprStr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return pyStr(v);
}

/** Python `str()` of a parsed JSON value. */
function pyStrAny(v: JsonValue): string {
  return typeof v === "string" ? v : pyRepr(v);
}

/** Python `str(status)` when `isinstance(status, int)` (bool included), else `"unknown"`. */
function statusText(status: unknown): string {
  if (typeof status === "number" && Number.isInteger(status)) return String(status);
  if (typeof status === "boolean") return status ? "True" : "False";
  return "unknown";
}

/**
 * Warn when an ingest response body says `ok: false`. Never throws. A
 * malformed, empty or non-JSON body is ignored.
 */
export function reportIngestRefusal(raw: Uint8Array | string | null | undefined, status: unknown, debug: boolean): void {
  try {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Uint8Array) text = utf8Decode(raw);
    else return;
    if (!pyStrip(text)) return;
    let body: JsonValue;
    try {
      body = parseJson(text);
    } catch {
      return;
    }
    if (!(body instanceof Map) || body.get("ok") !== false) return;

    let code: string;
    const err = body.get("error");
    const reason = body.get("reason");
    if (pyTruthy(err)) code = headCodePoints(pyStrAny(err as JsonValue), 80);
    else if (pyTruthy(reason)) code = headCodePoints(pyStrAny(reason as JsonValue), 80);
    else if (pyTruthy(body.get("rejected"))) code = "rejected";
    else code = "unknown";
    const statusStr = statusText(status);

    // Debug mode logs the decoded body for every refusal; the once-per-code
    // summary below is built from parsed fields only.
    if (debug) {
      console.warn(
        `stubsmith: ingest refused capture - status=${statusStr} body=${headCodePoints(text, INGEST_DEBUG_BODY_CHARS)}`,
      );
    }

    if (warnedCodes.has(code)) return;
    // A server-controlled code that varies per response must not turn into one
    // warning per variant; past the cap new codes stay quiet.
    if (warnedCodes.size >= INGEST_MAX_WARNED_CODES) return;
    warnedCodes.add(code);

    const message = dictGet(body, "message");
    let detail = "";
    if (typeof message === "string" && pyStrip(message)) {
      detail = headCodePoints(pyStrip(message), 200);
      if (!/[.!?]$/.test(detail)) detail += ".";
      detail += " ";
    }
    console.warn(
      `stubsmith: ingest refused a capture: ${code} (HTTP ${statusStr}). ${detail}${REMEDIES.get(code) ?? REMEDY_DEFAULT} Reported once per process.`,
    );
  } catch {
    // reporting must never break the sender
  }
}

