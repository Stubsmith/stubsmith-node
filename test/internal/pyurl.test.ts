import { describe, expect, it } from "vitest";
import { pyUrlParse } from "../../src/internal/pyurl.js";

describe("pyUrlParse", () => {
  it("keeps userinfo and port in netloc, drops the fragment", () => {
    const p = pyUrlParse("https://user:pw@api.example.com:8443/v1/things/9?x=1&y=#frag");
    expect(p.netloc).toBe("user:pw@api.example.com:8443");
    expect(p.path).toBe("/v1/things/9");
    expect(p.query).toBe("x=1&y=");
  });
  it("splits ;params only off the last segment", () => {
    expect(pyUrlParse("https://h/v1/a;p=1/b").path).toBe("/v1/a;p=1/b");
    expect(pyUrlParse("https://h/v1/b;p=1").path).toBe("/v1/b");
    expect(pyUrlParse("https://h/v1/b;p=1").params).toBe("p=1");
  });
  it("handles relative urls, tabs/newlines and leading control characters", () => {
    expect(pyUrlParse("/just/a/path?x=1")).toMatchObject({ netloc: "", path: "/just/a/path", query: "x=1" });
    expect(pyUrlParse("  http://h/a\tb\n").path).toBe("/ab");
  });
  it("rejects unbalanced brackets in the netloc", () => {
    expect(() => pyUrlParse("http://[::1/")).toThrow();
  });
});

describe("pyUrlParse bracketed hosts (Python 3.14 _check_bracketed_host)", () => {
  it.each([
    "http://[abc]/x",
    "http://[1.2.3.4]/x",
    "http://a[b]c/x",
    "http://[::1]x/y",
    "http://a[::1]/x",
    "http://[]/x",
    "http://[v]/x",
    "http://[v1.]/x",
    "http://[V1.a]/x",
    "http://[::1%]/x",
    "http://[::1%a%b]/x",
    "http://[1::2::3]/x",
    "http://[:1]/x",
    "http://[1:2:3:4:5:6:7:8:9]/x",
    "http://[01234::1]/x",
    "http://[::1.2.3]/x",
    "http://[::1.2.3.04]/x",
  ])("rejects %s", (u) => {
    expect(() => pyUrlParse(u)).toThrow();
  });
  it.each([
    "http://[::1]:8080/x",
    "http://[::1]/x",
    "http://[fe80::1%25eth0]/x",
    "http://[v1.fe]/x",
    "http://[::ffff:1.2.3.4]/x",
    "http://[0:0:0:0:0:0:0:1]/x",
    "http://[1:2:3:4:5:6:7::]/x",
    "http://u:p@[::1]:80/x",
  ])("accepts %s", (u) => {
    expect(pyUrlParse(u).path).toBe("/x");
  });
});
