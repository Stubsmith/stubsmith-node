import { describe, expect, it } from "vitest";
import { blake2bHex } from "../../src/internal/blake2b.js";
import { utf8Encode } from "../../src/internal/utf8.js";
import { loadVectors } from "../helpers/vectors.js";

interface In {
  digest_size: number;
  key_hex: string;
  key_utf8: string | null;
  text: string;
  utf8_bytes: number;
}

const file = loadVectors<In, { hex: string }>("blake2b.json");

describe("blake2b conformance vectors", () => {
  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const data = utf8Encode(c.input.text);
    expect(data.length).toBe(c.input.utf8_bytes);
    const key = c.input.key_hex ? Uint8Array.from(Buffer.from(c.input.key_hex, "hex")) : undefined;
    expect(blake2bHex(data, { digestLength: c.input.digest_size, key })).toBe(c.expected.hex);
  });
});
