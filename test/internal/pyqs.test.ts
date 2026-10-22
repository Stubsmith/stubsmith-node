import { describe, expect, it } from "vitest";
import { parseForm, parseQs, urlencodeDoseq } from "../../src/internal/pyqs.js";

// Expectations: python3 -c 'from urllib.parse import parse_qs; print(parse_qs(q, keep_blank_values=True))'
const PARSE: Array<[string, Array<[string, string[]]>]> = [
  ["a=1&b=2&a=3", [["a", ["1", "3"]], ["b", ["2"]]]],
  ["a=1&&b=2", [["a", ["1"]], ["b", ["2"]]]],
  ["a", [["a", [""]]]],
  ["a=", [["a", [""]]]],
  ["=b", [["", ["b"]]]],
  ["a=b=c", [["a", ["b=c"]]]],
  ["a+b=c%20d", [["a b", ["c d"]]]],
  ["%2B", [["+", [""]]]],
  ["x=!*'()~", [["x", ["!*'()~"]]]],
  ["k=/", [["k", ["/"]]]],
  ["é=ü", [["é", ["ü"]]]],
  ["%E9", [["\ufffd", [""]]]],
  ["a;b=1", [["a;b", ["1"]]]],
  ["a=1&", [["a", ["1"]]]],
  ["items[]=1&items[]=2", [["items[]", ["1", "2"]]]],
  ["a=%E9x&b=%zz&c=%4", [["a", ["\ufffdx"]], ["b", ["%zz"]], ["c", ["%4"]]]],
  ["a=%E2%82%AC", [["a", ["€"]]]],
  ["a=%F0%9F%98%80%C3", [["a", ["😀\ufffd"]]]],
  ["a=1&a=&a", [["a", ["1", "", ""]]]],
  ["", []],
  ["&&", []],
];

describe("parseQs", () => {
  it.each(PARSE)("%j", (qs, expected) => {
    expect([...parseQs(qs).entries()]).toEqual(expected);
  });
});

// Expectations: python3 -c 'from urllib.parse import urlencode; print(urlencode([("k"+s, s)], doseq=True))'
describe("urlencodeDoseq", () => {
  it.each([
    ["a b", "ka+b=a+b"],
    ["!*'()~", "k%21%2A%27%28%29~=%21%2A%27%28%29~"],
    ["é", "k%C3%A9=%C3%A9"],
    ["/", "k%2F=%2F"],
    ["😀", "k%F0%9F%98%80=%F0%9F%98%80"],
    ["a&b=c", "ka%26b%3Dc=a%26b%3Dc"],
    ["_.-~", "k_.-~=_.-~"],
    ["100%", "k100%25=100%25"],
    ["\x00", "k%00=%00"],
  ])("pair %j", (s, expected) => {
    expect(urlencodeDoseq([["k" + s, s]])).toBe(expected);
  });

  it("Map with repeated keys keeps order", () => {
    expect(urlencodeDoseq(parseQs("a=1&b=2&a=3"))).toBe("a=1&a=3&b=2");
    expect(urlencodeDoseq(parseQs("items[]=1&items[]=2"))).toBe("items%5B%5D=1&items%5B%5D=2");
  });

  it("array form and empty", () => {
    expect(urlencodeDoseq([["a", ""], ["a", "<masked>"]])).toBe("a=&a=%3Cmasked%3E");
    expect(urlencodeDoseq([])).toBe("");
  });
});

describe("parseForm", () => {
  it("is null when any non-empty segment has no =", () => {
    expect(parseForm("Dear SECRET, your PIN is 1234")).toBeNull();
    expect(parseForm("a=1&Dear SECRET")).toBeNull();
  });

  it("parses a body of key=value pairs like parseQs", () => {
    expect([...(parseForm("a=1&&b=&c=x=y&") ?? [])]).toEqual([["a", ["1"]], ["b", [""]], ["c", ["x=y"]]]);
    expect(parseForm("")?.size).toBe(0);
  });
});
