import { describe, expect, it } from "vitest";
import { hasLoneSurrogate, pyIsDigit, pyStrip, utf8EncodeStrict } from "../../src/internal/pystr.js";

describe("pyIsDigit", () => {
  it.each([
    ["0123", true],
    ["\u00b2", true], // superscript two: Numeric_Type=Digit
    ["\u2467", true], // circled digit eight
    ["\u0663\u0664", true], // Arabic-Indic digits (Nd)
    ["\u2167", false], // roman numeral eight: Numeric_Type=Numeric
    ["\u00bd", false], // one half
    ["", false],
    ["1a", false],
    ["1.5", false],
  ])("%j", (s, expected) => {
    expect(pyIsDigit(s)).toBe(expected);
  });
});

describe("pyStrip", () => {
  it("strips Python whitespace, not U+FEFF", () => {
    expect(pyStrip("\x1c\x85 a \u3000")).toBe("a");
    expect(pyStrip("\ufeffa")).toBe("\ufeffa");
  });
});

describe("strict utf-8", () => {
  it("rejects lone surrogates", () => {
    expect(hasLoneSurrogate("a\ud800")).toBe(true);
    expect(hasLoneSurrogate("\ud83d\ude00")).toBe(false);
    expect(() => utf8EncodeStrict("\udc00")).toThrow();
  });
});
