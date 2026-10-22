import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// conformance/VECTORS_VERSION records a SHA-256 per vector file (tools/gen-vectors.py write_version).
// A vector edited by hand, or regenerated without updating the record, fails here.
const dir = new URL("../conformance/", import.meta.url);

function recorded(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(new URL("VECTORS_VERSION", dir), "utf8").split("\n")) {
    const m = /^ {2}([\w.-]+\.json): ([0-9a-f]{64})$/.exec(line);
    if (m) out.set(m[1] as string, m[2] as string);
  }
  return out;
}

describe("conformance/VECTORS_VERSION", () => {
  it("records the Python SDK version and no commit id", () => {
    const text = readFileSync(new URL("VECTORS_VERSION", dir), "utf8");
    expect(text).toMatch(/^python_sdk_version: \d+\.\d+\.\d+$/m);
    expect(text).not.toMatch(/commit/);
    // A run of 7 or more hex characters anywhere but a file digest line would be a (short) commit id.
    const other = text.split("\n").filter((l) => !/^ {2}[\w.-]+\.json: [0-9a-f]{64}$/.test(l));
    for (const l of other) expect(l).not.toMatch(/[0-9a-f]{7,}/i);
  });

  it("matches the SHA-256 of every vector file", () => {
    const files = readdirSync(new URL("vectors/", dir)).filter((f) => f.endsWith(".json")).sort();
    const rec = recorded();
    expect([...rec.keys()].sort()).toEqual(files);
    for (const f of files) {
      const digest = createHash("sha256").update(readFileSync(new URL(`vectors/${f}`, dir))).digest("hex");
      expect(digest, f).toBe(rec.get(f));
    }
  });
});
