import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_URL,
  WARN_ONCE_CAP,
  debugLog,
  parseBool,
  parseFlushTimeout,
  readEnv,
  resetWarnOnceForTests,
  setDebug,
  warnOnce,
} from "../src/env.js";

const NAMES = [
  "STUBSMITH_URL",
  "STUBSMITH_API_KEY",
  "STUBSMITH_BACKEND_URL",
  "STUBSMITH_API_URL",
  "STUBSMITH_DEBUG",
  "STUBSMITH_FLUSH_TIMEOUT",
  "STUBSMITH_MASK_SALT",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  setDebug(undefined);
  resetWarnOnceForTests();
});

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  setDebug(undefined);
  vi.restoreAllMocks();
});

describe("readEnv", () => {
  it("uses the SPEC defaults when nothing is set", () => {
    expect(readEnv()).toEqual({
      url: DEFAULT_URL,
      apiKey: "",
      backendUrl: DEFAULT_BACKEND_URL,
      apiUrl: "",
      debug: false,
      flushTimeoutS: 1.0,
      maskSalt: "",
    });
    expect(DEFAULT_URL).toBe("https://ingest.stubsmith.dev/v1/captures");
    expect(DEFAULT_BACKEND_URL).toBe("https://app.stubsmith.dev/api");
  });

  it("reads every variable", () => {
    process.env["STUBSMITH_URL"] = "http://i/x";
    process.env["STUBSMITH_API_KEY"] = "k";
    process.env["STUBSMITH_BACKEND_URL"] = "http://b";
    process.env["STUBSMITH_API_URL"] = "http://a";
    process.env["STUBSMITH_DEBUG"] = "yes";
    process.env["STUBSMITH_FLUSH_TIMEOUT"] = "2.5";
    process.env["STUBSMITH_MASK_SALT"] = "salt";
    expect(readEnv()).toEqual({
      url: "http://i/x",
      apiKey: "k",
      backendUrl: "http://b",
      apiUrl: "http://a",
      debug: true,
      flushTimeoutS: 2.5,
      maskSalt: "salt",
    });
  });
});

describe("parsers", () => {
  it("treats 1, true, yes (any case, trimmed) as truthy only", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "Yes"]) expect(parseBool(v)).toBe(true);
    for (const v of ["0", "false", "no", "", "2", undefined]) expect(parseBool(v)).toBe(false);
  });

  it("parses the flush timeout as float seconds, ignoring malformed values", () => {
    expect(parseFlushTimeout(undefined)).toBe(1.0);
    expect(parseFlushTimeout("0")).toBe(0);
    expect(parseFlushTimeout("0.25")).toBe(0.25);
    expect(parseFlushTimeout("-3")).toBe(0);
    expect(parseFlushTimeout("abc")).toBe(1.0);
    expect(parseFlushTimeout("Infinity")).toBe(1.0);
  });

  it("matches Python float() for decimal forms and rejects hex, binary and non-finite", () => {
    expect(parseFlushTimeout("1_000")).toBe(1000);
    expect(parseFlushTimeout("1_0.5_5")).toBe(10.55);
    expect(parseFlushTimeout(" +2.5 ")).toBe(2.5);
    expect(parseFlushTimeout(".5")).toBe(0.5);
    expect(parseFlushTimeout("2.")).toBe(2);
    expect(parseFlushTimeout("1e2")).toBe(100);
    expect(parseFlushTimeout("1E-1")).toBe(0.1);
    for (const bad of ["0x10", "0b11", "0o7", "1__0", "_1", "1_", "1_.5", "1._5", ".", "e5", "1e", "inf", "-inf", "nan", "1e999", "1,5"]) {
      expect(parseFlushTimeout(bad), bad).toBe(1.0);
    }
  });
});

describe("debugLog", () => {
  it("is silent unless debug is on", () => {
    const w = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    debugLog("hidden");
    expect(w).not.toHaveBeenCalled();
    process.env["STUBSMITH_DEBUG"] = "1";
    debugLog("shown");
    expect(w).toHaveBeenCalledTimes(1);
    expect(String(w.mock.calls[0]?.[0])).toBe("stubsmith: shown\n");
  });

  it("an explicit setDebug beats the env var", () => {
    const w = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.env["STUBSMITH_DEBUG"] = "1";
    setDebug(false);
    debugLog("x");
    expect(w).not.toHaveBeenCalled();
    setDebug(true);
    process.env["STUBSMITH_DEBUG"] = "0";
    debugLog("y");
    expect(w).toHaveBeenCalledTimes(1);
  });
});

describe("warnOnce", () => {
  it("prints once per key", () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(warnOnce("a", "first")).toBe(true);
    expect(warnOnce("a", "again")).toBe(false);
    expect(warnOnce("b", "other")).toBe(true);
    expect(w.mock.calls.map((c) => c[0])).toEqual(["first", "other"]);
  });

  it("stays quiet for new keys past the cap", () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < WARN_ONCE_CAP + 10; i++) warnOnce(`k${i}`, "m");
    expect(w).toHaveBeenCalledTimes(WARN_ONCE_CAP);
    expect(warnOnce("k0", "m")).toBe(false);
  });
});
