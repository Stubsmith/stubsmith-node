/**
 * Environment configuration, debug logging and once-per-process warnings.
 * Names and defaults follow SPEC.md section 4 (Python `client.py`).
 */

export const DEFAULT_URL = "https://ingest.stubsmith.dev/v1/captures";
export const DEFAULT_BACKEND_URL = "https://app.stubsmith.dev/api";
/** Exit-flush budget in seconds when `STUBSMITH_FLUSH_TIMEOUT` is unset or malformed. */
export const DEFAULT_FLUSH_TIMEOUT_S = 1.0;

export interface EnvConfig {
  url: string;
  apiKey: string;
  backendUrl: string;
  /** `STUBSMITH_API_URL`; empty when unset (the CLI falls back to the backend URL). */
  apiUrl: string;
  debug: boolean;
  /** Seconds, never negative. */
  flushTimeoutS: number;
  maskSalt: string;
}

function env(name: string): string | undefined {
  return process.env[name];
}

/** `1`, `true`, `yes` (case-insensitive, trimmed) are truthy; anything else is not. */
export function parseBool(raw: string | undefined): boolean {
  return ["1", "true", "yes"].includes((raw ?? "").trim().toLowerCase());
}

/** Python `float()` decimal grammar: digits with single underscores between them, optional fraction and exponent. */
const PY_FLOAT_RE = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;

/**
 * Seconds from `raw`, accepting what Python `float()` accepts for decimal
 * numbers (`1_000`, `.5`, `1e2`; not `0x10` or `0b11`, which `Number()` would).
 * A malformed value is ignored (the SDK must never break the host). Python also
 * accepts `inf` and `nan`; those are rejected here (fallback 1.0) because an
 * unbounded exit wait would let a dead endpoint hang the application forever,
 * and a value that overflows to Infinity (`1e999`) is treated the same way.
 */
export function parseFlushTimeout(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  if (s && PY_FLOAT_RE.test(s)) {
    const n = Number(s.replace(/_/g, ""));
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return DEFAULT_FLUSH_TIMEOUT_S;
}

/** Read every `STUBSMITH_*` variable with the SPEC defaults. */
export function readEnv(): EnvConfig {
  return {
    url: env("STUBSMITH_URL") || DEFAULT_URL,
    apiKey: env("STUBSMITH_API_KEY") ?? "",
    backendUrl: env("STUBSMITH_BACKEND_URL") || DEFAULT_BACKEND_URL,
    apiUrl: env("STUBSMITH_API_URL") ?? "",
    debug: parseBool(env("STUBSMITH_DEBUG")),
    flushTimeoutS: parseFlushTimeout(env("STUBSMITH_FLUSH_TIMEOUT")),
    maskSalt: env("STUBSMITH_MASK_SALT") ?? "",
  };
}

let debugOverride: boolean | undefined;

/** Pin the debug flag (a client constructed with an explicit `debug`); `undefined` goes back to the env var. */
export function setDebug(on: boolean | undefined): void {
  debugOverride = on;
}

export function isDebug(): boolean {
  return debugOverride ?? parseBool(env("STUBSMITH_DEBUG"));
}

/** Print to stderr only when debug is on. Never throws. */
export function debugLog(msg: string): void {
  if (!isDebug()) return;
  try {
    process.stderr.write(`stubsmith: ${msg}\n`);
  } catch {
    // stderr may be closed; logging must never break the host.
  }
}

/** Cap on distinct keys remembered by {@link warnOnce} (client.py `_INGEST_MAX_WARNED_CODES`). */
export const WARN_ONCE_CAP = 64;

const warned = new Set<string>();

/**
 * `console.warn(msg)` once per process per `key`. Past {@link WARN_ONCE_CAP}
 * distinct keys new keys stay quiet, so a varying key cannot flood the logs.
 * Returns true when the message was printed.
 */
export function warnOnce(key: string, msg: string): boolean {
  if (warned.has(key) || warned.size >= WARN_ONCE_CAP) return false;
  warned.add(key);
  try {
    console.warn(msg);
  } catch {
    // never break the host
  }
  return true;
}

/** Test hook: forget every warned key. */
export function resetWarnOnceForTests(): void {
  warned.clear();
}

/** Backend base URL for `pull` / `fetchBundle`: `STUBSMITH_API_URL`, then `STUBSMITH_BACKEND_URL`, then the hosted default. */
export function resolveApiUrl(): string {
  return env("STUBSMITH_API_URL") || env("STUBSMITH_BACKEND_URL") || DEFAULT_BACKEND_URL;
}

/** Base URL for the fixtures API: `STUBSMITH_API_URL` only (SPEC 1.4), then the hosted default. */
export function resolveFixturesApiUrl(): string {
  return env("STUBSMITH_API_URL") || DEFAULT_BACKEND_URL;
}
