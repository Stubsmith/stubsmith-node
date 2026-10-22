import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translatePythonRegex } from "../../src/internal/pyre.js";
import { applyRegexes, compileRules } from "../../src/privacy/masking.js";

// conformance/regex-corpus.json is a copy of the API's regex corpus: every pattern the API accepts on save, with
// what Python's re.sub returns on each input. The SDK must mask kept strings the same way.
// conformance/regex-corpus.sha256 is a copy of the API's record of the corpus digest, so an edited or partial
// copy fails here instead of silently testing less.
interface Corpus {
  inputs: string[];
  accepted: { pattern: string; flags?: string; expected: string[] }[];
  rejected: { pattern: string; problem: string }[];
}
const corpusUrl = new URL("../../conformance/regex-corpus.json", import.meta.url);
const raw = readFileSync(corpusUrl);
const corpus = JSON.parse(raw.toString("utf8")) as Corpus;

describe("regex corpus copy", () => {
  it("is the API's corpus, byte for byte", () => {
    const recorded = readFileSync(new URL("../../conformance/regex-corpus.sha256", import.meta.url), "utf8").trim();
    expect(createHash("sha256").update(raw).digest("hex")).toBe(recorded);
  });

  it("is not empty, and covers the i flag", () => {
    expect(corpus.accepted.length).toBeGreaterThan(50);
    expect(corpus.inputs.length).toBeGreaterThan(30);
    expect(corpus.accepted.filter((e) => (e.flags ?? "").includes("i")).length).toBeGreaterThan(3);
  });
});

describe("regex corpus (patterns the API accepts)", () => {
  it.each(corpus.accepted.map((e) => [e.pattern, e] as const))("%s masks like Python", (_p, e) => {
    const rules = compileRules([], [{ pattern: e.pattern, flags: e.flags ?? "", replace: "<m>" }]);
    expect(rules.regexMasks).toHaveLength(1); // translated, not dropped or flagged
    expect(corpus.inputs.map((s) => applyRegexes(s, rules))).toEqual(e.expected);
  });
});

// The translation must not make an accepted pattern slow, under either flag: e.g. the i/İ/ı fold once turned
// [a-z]+$ into an ambiguous alternation. Short text catches exponential growth without hanging the run.
// A shared CI runner can stall any single run (GC, JIT, a noisy neighbour), so each check takes the best of 3
// runs: a stall shows in one run, a slow pattern in all three. Healthy patterns take well under 1 ms here
// (best of 3), so 100 ms is wide headroom. The alternation fold grows about 16x per 4 characters; its slowest
// pattern stays under 100 ms up to length 24 and takes about 0.6 s at 28, so the steps go up to 32: an
// exponential pattern has to fail on short text before the 400-character check, or that check hangs.
describe("translated patterns stay fast", () => {
  const SHAPES = ["a", "i", "I", "ab", " ", "a ", "1", "a.", "@a", "a,", "a-"];
  const time = (re: RegExp, length: number): number => {
    const t = performance.now();
    for (const ch of SHAPES) {
      const body = ch.repeat(Math.floor(length / ch.length));
      (body + "!").replace(re, "#");
      ("!" + body).replace(re, "#");
    }
    return performance.now() - t;
  };
  // Best of 3, stopping at the first run under the budget.
  const bestOf3 = (re: RegExp, length: number, budget: number): number => {
    let best = Infinity;
    for (let run = 0; run < 3 && best >= budget; run++) best = Math.min(best, time(re, length));
    return best;
  };

  it.each(corpus.accepted.flatMap((e) => ["", "i"].map((f) => [e.pattern, f] as const)))("%s (flags %j)", (pattern, flags) => {
    const t = translatePythonRegex(pattern, flags);
    if ("error" in t) throw new Error(t.error);
    // Step up the length, so an exponential pattern fails on short text instead of hanging on long text.
    for (const length of [16, 20, 24, 28, 32]) expect(bestOf3(t.regex, length, 100)).toBeLessThan(100);
    expect(bestOf3(t.regex, 400, 250)).toBeLessThan(250);
  });
});
