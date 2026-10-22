import { describe, expect, it } from "vitest";
import { truncateUtf8Bytes, utf8Decode, utf8Encode } from "../../src/internal/utf8.js";

describe("utf8", () => {
  it("round-trips", () => {
    const s = "a é € 😀";
    expect(utf8Decode(utf8Encode(s))).toBe(s);
    expect([...utf8Encode("é")]).toEqual([0xc3, 0xa9]);
  });

  it("non-fatal decode replaces, fatal throws", () => {
    expect(utf8Decode(Uint8Array.of(0xe9, 0x41))).toBe("�A");
    expect(() => utf8Decode(Uint8Array.of(0xe9), { fatal: true })).toThrow();
  });

  it("keeps a BOM", () => {
    expect(utf8Decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41))).toBe("﻿A");
  });

  it("truncates by raw bytes like Python encode()[:n]", () => {
    expect(utf8Encode("a".repeat(100)).length).toBe(100);
    expect(truncateUtf8Bytes("a".repeat(100), 64).length).toBe(64);
    expect([...truncateUtf8Bytes("aé", 2)]).toEqual([0x61, 0xc3]); // cut mid-character
    expect(truncateUtf8Bytes("abc", 64).length).toBe(3);
  });
});
