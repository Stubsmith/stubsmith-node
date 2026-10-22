import { describe, expect, it } from "vitest";
import { translatePythonRegex } from "../../src/internal/pyre.js";

const EMAIL = String.raw`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`;
const CARD = String.raw`\b(?:\d[ \-]?){15}\d\b`;

function sub(pattern: string, flags: string, s: string): string {
  const r = translatePythonRegex(pattern, flags);
  if ("error" in r) throw new Error(r.error);
  return s.replace(r.regex, "#");
}
const masked = (pattern: string, s: string): string => sub(pattern, "", s).replace(/#/g, "<masked>");

// Expectations: python3 -c 'import re; print(re.sub(p, "#", s, flags=f))'
describe("translatePythonRegex: email- and card-shaped patterns", () => {
  it.each([
    ["mail bob.smith+x@example.co.uk now", "mail <masked> now"],
    ["none@x", "none@x"],
    ["a@b.c", "a@b.c"],
    ["émail é@ex.com", "émail é@ex.com"],
  ])("email %j", (s, expected) => {
    expect(masked(EMAIL, s)).toBe(expected);
  });

  it.each([
    ["card 4111 1111 1111 1111 ok", "card <masked> ok"],
    ["4111-1111-1111-1111", "<masked>"],
    ["41111111 11111111 and 4111111111111111x", "<masked> and 4111111111111111x"],
    ["٤١١١ ١١١١ ١١١١ ١١١١ arabic digits", "<masked> arabic digits"], // Unicode \d like Python
    ["a@b.c", "a@b.c"],
  ])("card %j", (s, expected) => {
    expect(masked(CARD, s)).toBe(expected);
  });
});

describe("translatePythonRegex: dialect", () => {
  const cases: Array<[string, string, string[], string[]]> = [
    ["(?P<x>a)(?P=x)", "", ["aa", "ab", "xaax"], ["#", "ab", "x#x"]],
    ["(?i)abc", "", ["xABCx", "ab"], ["x#x", "ab"]],
    ["abc", "i", ["ABC"], ["#"]],
    [String.raw`foo\Z`, "", ["foo", "foo\n", "foox"], ["#", "foo\n", "foox"]],
    [String.raw`\Afoo`, "", ["foo\nfoo"], ["#\nfoo"]],
    ["^a$", "", ["a\n", "a", "b\na"], ["#\n", "#", "b\na"]],
    ["(?m)^a$", "", ["b\na\nc", "a\r\nb"], ["b\n#\nc", "a\r\nb"]],
    ["a.b", "", ["a\nb", "a\rb", "axb"], ["a\nb", "#", "#"]],
    ["(?s)a.b", "", ["a\nb"], ["#"]],
    [String.raw`(?<=\$)\d+`, "", ["cost $45"], ["cost $#"]],
    [String.raw`\w+`, "", ["héllo wörld"], ["# #"]],
    [String.raw`\s+`, "", ["a\x1cb\u00a0c\ufeffd"], ["a#b#c\ufeffd"]],
    ["a{,2}b", "", ["aab", "b", "aaab"], ["#", "#", "a#"]],
    ["a{x", "", ["a{x"], ["#"]],
    ["[]a]+", "", ["]a]"], ["#"]],
    ["[^]a]+", "", ["]abc"], ["]a#"]],
    [String.raw`\bfoo\b`, "", ["foo é foo_ foo"], ["# é foo_ #"]],
    ["x(?#hi)y", "", ["xy"], ["#"]],
    [String.raw`[\w-]+`, "", ["a-b c"], ["# #"]],
    [String.raw`\.\@\ `, "", [".@ "], ["#"]],
  ];
  it.each(cases)("%s flags=%j", (pattern, flags, inputs, expected) => {
    expect(inputs.map((s) => sub(pattern, flags, s))).toEqual(expected);
  });

  it("returns a global regex and adds i only when asked", () => {
    const a = translatePythonRegex("abc", "i");
    const b = translatePythonRegex("abc", "");
    expect("regex" in a && a.regex.flags).toBe("giu");
    expect("regex" in b && b.regex.flags).toBe("gu");
  });
});

describe("translatePythonRegex: errors", () => {
  it.each([
    ["(", "unterminated group"],
    ["[a", "unterminated class"],
    ["a++", "possessive"],
    ["a*+", "possessive"],
    ["a{2}+", "possessive"],
    ["(?>a)", "atomic"],
    ["(?x)a b", "x flag"],
    ["(?i:a)", "scoped flags"],
    ["a(?i)b", "mid-pattern flags"],
    ["(?(1)a|b)", "conditional"],
    [String.raw`\p{L}`, "unknown escape"],
    [String.raw`\N{DIGIT ONE}`, "named char"],
    ["(?<n>a)", "JS-only named group"],
    ["a\\", "trailing backslash"],
  ])("%s (%s)", (pattern) => {
    const r = translatePythonRegex(pattern, "");
    expect("error" in r).toBe(true);
  });

  it("does not throw on garbage", () => {
    expect("error" in translatePythonRegex("*a", "")).toBe(true);
    expect("error" in translatePythonRegex("(?P=nope)", "")).toBe(true);
  });
});

// Expectations: python3 -c 'import re; print(re.sub(p, "#", s))' for each pattern and sample.
const CLASS_SAMPLES = ["h\u00e9llo w\u00f6rld 123", "\u00dcn\u00ef_c\u00f6d\u00e9 42", "\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8 \u0661\u0662\u0663", "a b\tc\nd", "x\u00a0y\u2003z", "abc-def_9", "  ", "", "\u0391\u0392\u0393 \u03b4\u03b5\u03b6 5", "#@!$%^&*()", "a1b2c3", "f0xAB", "\u0663\u0664 e", "\u00df_\u01c5", "\u001c\u0085z", "e\u0301x", "tab\there", "\ud83d\ude00 emoji", "a.b,c;d", "baaa"];
const CLASS_CASES: Array<[string, string[]]> = [
  ["[\\s\\S]", ["###############", "###########", "###########", "#######", "#####", "#########", "##", "", "#########", "##########", "######", "#####", "####", "###", "###", "###", "########", "#######", "#######", "####"]],
  ["[\\d\\D]", ["###############", "###########", "###########", "#######", "#####", "#########", "##", "", "#########", "##########", "######", "#####", "####", "###", "###", "###", "########", "#######", "#######", "####"]],
  ["[\\w\\W]", ["###############", "###########", "###########", "#######", "#####", "#########", "##", "", "#########", "##########", "######", "#####", "####", "###", "###", "###", "########", "#######", "#######", "####"]],
  ["[^\\W_]", ["##### ##### ###", "###_#### ##", "### ### ###", "# #\t#\n#", "#\u00a0#\u2003#", "###-###_#", "  ", "", "### ### #", "#@!$%^&*()", "######", "#####", "## #", "#_#", "\u001c\u0085#", "#\u0301#", "###\t####", "\ud83d\ude00 #####", "#.#,#;#", "####"]],
  ["[\\Da-f]", ["############123", "#########42", "########\u0661\u0662\u0663", "#######", "#####", "########9", "##", "", "########5", "##########", "#1#2#3", "#0###", "\u0663\u0664##", "###", "###", "###", "########", "#######", "#######", "####"]],
  ["[\\S ]", ["###############", "###########", "###########", "###\t#\n#", "#\u00a0#\u2003#", "#########", "##", "", "#########", "##########", "######", "#####", "####", "###", "\u001c\u0085#", "###", "###\t####", "#######", "#######", "####"]],
  ["[^\\S ]", ["h\u00e9llo w\u00f6rld 123", "\u00dcn\u00ef_c\u00f6d\u00e9 42", "\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8 \u0661\u0662\u0663", "a b#c#d", "x#y#z", "abc-def_9", "  ", "", "\u0391\u0392\u0393 \u03b4\u03b5\u03b6 5", "#@!$%^&*()", "a1b2c3", "f0xAB", "\u0663\u0664 e", "\u00df_\u01c5", "##z", "e\u0301x", "tab#here", "\ud83d\ude00 emoji", "a.b,c;d", "baaa"]],
  ["[^\\D5]", ["h\u00e9llo w\u00f6rld ###", "\u00dcn\u00ef_c\u00f6d\u00e9 ##", "\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8 ###", "a b\tc\nd", "x\u00a0y\u2003z", "abc-def_#", "  ", "", "\u0391\u0392\u0393 \u03b4\u03b5\u03b6 5", "#@!$%^&*()", "a#b#c#", "f#xAB", "## e", "\u00df_\u01c5", "\u001c\u0085z", "e\u0301x", "tab\there", "\ud83d\ude00 emoji", "a.b,c;d", "baaa"]],
  ["[\\W\\S]", ["###############", "###########", "###########", "#######", "#####", "#########", "##", "", "#########", "##########", "######", "#####", "####", "###", "###", "###", "########", "#######", "#######", "####"]],
  ["[^\\W\\S]", ["h\u00e9llo w\u00f6rld 123", "\u00dcn\u00ef_c\u00f6d\u00e9 42", "\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8 \u0661\u0662\u0663", "a b\tc\nd", "x\u00a0y\u2003z", "abc-def_9", "  ", "", "\u0391\u0392\u0393 \u03b4\u03b5\u03b6 5", "#@!$%^&*()", "a1b2c3", "f0xAB", "\u0663\u0664 e", "\u00df_\u01c5", "\u001c\u0085z", "e\u0301x", "tab\there", "\ud83d\ude00 emoji", "a.b,c;d", "baaa"]],
  ["[\\Wa]+", ["h\u00e9llo#w\u00f6rld#123", "\u00dcn\u00ef_c\u00f6d\u00e9#42", "\u65e5\u672c\u8a9e#\u30c6\u30b9\u30c8#\u0661\u0662\u0663", "#b#c#d", "x#y#z", "#bc#def_9", "#", "", "\u0391\u0392\u0393#\u03b4\u03b5\u03b6#5", "#", "#1b2c3", "f0xAB", "\u0663\u0664#e", "\u00df_\u01c5", "#z", "e#x", "t#b#here", "#emoji", "#b#c#d", "b#"]],
  ["[^\\W\\d]+", ["# # 123", "# 42", "# # \u0661\u0662\u0663", "# #\t#\n#", "#\u00a0#\u2003#", "#-#9", "  ", "", "# # 5", "#@!$%^&*()", "#1#2#3", "#0#", "\u0663\u0664 #", "#", "\u001c\u0085#", "#\u0301#", "#\t#", "\ud83d\ude00 #", "#.#,#;#", "#"]],
  ["[a\\-\\W]", ["h\u00e9llo#w\u00f6rld#123", "\u00dcn\u00ef_c\u00f6d\u00e9#42", "\u65e5\u672c\u8a9e#\u30c6\u30b9\u30c8#\u0661\u0662\u0663", "##b#c#d", "x#y#z", "#bc#def_9", "##", "", "\u0391\u0392\u0393#\u03b4\u03b5\u03b6#5", "##########", "#1b2c3", "f0xAB", "\u0663\u0664#e", "\u00df_\u01c5", "##z", "e#x", "t#b#here", "##emoji", "##b#c#d", "b###"]],
  ["a{,}", ["#h#\u00e9#l#l#o# #w#\u00f6#r#l#d# #1#2#3#", "#\u00dc#n#\u00ef#_#c#\u00f6#d#\u00e9# #4#2#", "#\u65e5#\u672c#\u8a9e# #\u30c6#\u30b9#\u30c8# #\u0661#\u0662#\u0663#", "## #b#\t#c#\n#d#", "#x#\u00a0#y#\u2003#z#", "##b#c#-#d#e#f#_#9#", "# # #", "#", "#\u0391#\u0392#\u0393# #\u03b4#\u03b5#\u03b6# #5#", "###@#!#$#%#^#&#*#(#)#", "##1#b#2#c#3#", "#f#0#x#A#B#", "#\u0663#\u0664# #e#", "#\u00df#_#\u01c5#", "#\u001c#\u0085#z#", "#e#\u0301#x#", "#t##b#\t#h#e#r#e#", "#\ud83d\ude00# #e#m#o#j#i#", "##.#b#,#c#;#d#", "#b##"]],
];

describe("translatePythonRegex: negated escapes inside a character class", () => {
  it.each(CLASS_CASES)("%s matches Python re.sub", (pattern, expected) => {
    expect(CLASS_SAMPLES.map((s) => sub(pattern, "", s))).toEqual(expected);
  });

  it("does not return an error for [\\s\\S], [\\d\\D], [\\w\\W]", () => {
    for (const p of ["[\\s\\S]", "[\\d\\D]", "[\\w\\W]", "[^\\W_]", "[\\Da-f]", "[\\S ]"]) {
      expect("error" in translatePythonRegex(p, "")).toBe(false);
    }
  });

  it("quantifier applies to the whole rewritten class", () => {
    // python3: re.sub(r"[\Wa]{2}", "#", "a-b a") -> '#b#'
    expect(sub("[\\Wa]{2}", "", "a-b a")).toBe("#b#");
  });

  it("rejects a range ending in a negated escape, like Python", () => {
    expect("error" in translatePythonRegex("[a-\\W]", "")).toBe(true);
  });
});

describe("translatePythonRegex: {,} quantifier", () => {
  // python3: re.sub("a{,}", "#", "baaa") -> '#b##' (same as a*)
  it("a{,} is 0..infinity, not a literal", () => {
    expect(sub("a{,}", "", "baaa")).toBe("#b##");
    expect(sub("a*", "", "baaa")).toBe("#b##");
    // python3: re.sub("a{,}", "#", "a{,}") -> '##{#,#}#'
    expect(sub("a{,}", "", "a{,}")).toBe("##{#,#}#");
  });
});


// Expectations: python3 -c 'import re; print(re.sub(p, "#", s))'
describe("translatePythonRegex: i, I, İ and ı fold together under i, as in Python", () => {
  it.each([
    ["(?i)i", "iIİı x", "#### x"],
    ["(?i)ı", "iIİı x", "#### x"],
    ["(?i)[a-z]+", "İstanbul ıi", "# #"],
    ["(?i)[^a-z]", "İı1", "İı#"],
    ["(?i)\\x49", "iİı", "###"],
    ["i", "iIİı", "#Iİı"],
    ["[i]", "iİ", "#İ"],
  ])("%j on %j", (p, s, expected) => {
    expect(sub(p, "", s)).toBe(expected);
  });

  it("applies with the rule flag too", () => {
    expect(sub("ski", "i", "SKİ skı")).toBe("# #");
  });
});
