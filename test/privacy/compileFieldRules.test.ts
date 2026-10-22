import { describe, expect, it } from "vitest";
import { compileFieldRules } from "../../src/privacy/fieldRules.js";

const hasScoped = (list: readonly (readonly [number, string])[], status: number, path: string): boolean =>
  list.some(([s, p]) => s === status && p === path);

describe("compileFieldRules", () => {
  it("compiles a body keep rule", () => {
    const rules = compileFieldRules([{ path: "body.user.email", action: "keep" }]);
    expect(rules.keepBody.has("user.email")).toBe(true);
  });

  it("compiles a query keep rule", () => {
    const rules = compileFieldRules([{ path: "query.page", action: "keep" }]);
    expect(rules.keepQuery.has("page")).toBe(true);
  });

  it("lowercases a header keep rule", () => {
    const rules = compileFieldRules([{ path: "header.X-Request-Id", action: "keep" }]);
    expect(rules.keepHeader.has("x-request-id")).toBe(true);
  });

  it("does not add a mask action", () => {
    const rules = compileFieldRules([{ path: "body.password", action: "mask" }]);
    expect(rules.keepBody.has("password")).toBe(false);
  });

  it("ignores the path namespace", () => {
    const rules = compileFieldRules([{ path: "path.{id}", action: "keep" }]);
    expect(rules.keepBody.size).toBe(0);
    expect(rules.keepQuery.size).toBe(0);
    expect(rules.keepHeader.size).toBe(0);
  });

  it("compiles an empty list to empty sets", () => {
    const rules = compileFieldRules([]);
    expect(rules.keepBody.size).toBe(0);
    expect(rules.keepQuery.size).toBe(0);
    expect(rules.keepHeader.size).toBe(0);
  });

  it("compiles a resp keep rule", () => {
    const rules = compileFieldRules([{ path: "resp.id", action: "keep" }]);
    expect(rules.keepResp.has("id")).toBe(true);
  });

  it("compiles a nested resp keep rule", () => {
    const rules = compileFieldRules([{ path: "resp.user.email", action: "keep" }]);
    expect(rules.keepResp.has("user.email")).toBe(true);
  });

  it("does not add a resp mask action", () => {
    const rules = compileFieldRules([{ path: "resp.secret", action: "mask" }]);
    expect(rules.keepResp.has("secret")).toBe(false);
  });

  it("does not let a resp keep rule keep the request body field", () => {
    const rules = compileFieldRules([{ path: "resp.id", action: "keep" }]);
    expect(rules.keepBody.has("id")).toBe(false);
  });

  it("keeps no response fields for an empty list", () => {
    expect(compileFieldRules([]).keepResp.size).toBe(0);
  });
});

describe("compileFieldRules resp_header namespace", () => {
  it("lowercases a resp_header keep rule", () => {
    const rules = compileFieldRules([{ path: "resp_header.X-Trace-Id", action: "keep" }]);
    expect(rules.keepRespHeader.has("x-trace-id")).toBe(true);
  });

  it("does not let a resp_header keep rule keep the request header", () => {
    const rules = compileFieldRules([{ path: "resp_header.authorization", action: "keep" }]);
    expect(rules.keepHeader.has("authorization")).toBe(false);
  });

  it("does not let a header keep rule keep the response header", () => {
    const rules = compileFieldRules([{ path: "header.authorization", action: "keep" }]);
    expect(rules.keepRespHeader.has("authorization")).toBe(false);
  });

  it("does not add a resp_header mask action", () => {
    const rules = compileFieldRules([{ path: "resp_header.x-secret", action: "mask" }]);
    expect(rules.keepRespHeader.has("x-secret")).toBe(false);
  });

  it("keeps no response headers for an empty list", () => {
    expect(compileFieldRules([]).keepRespHeader.size).toBe(0);
  });

  it("keeps the header, resp_header and resp namespaces independent", () => {
    const rules = compileFieldRules([
      { path: "header.authorization", action: "keep" },
      { path: "resp_header.x-request-id", action: "keep" },
      { path: "resp.id", action: "keep" },
    ]);
    expect(rules.keepHeader.has("authorization")).toBe(true);
    expect(rules.keepRespHeader.has("authorization")).toBe(false);
    expect(rules.keepRespHeader.has("x-request-id")).toBe(true);
    expect(rules.keepHeader.has("x-request-id")).toBe(false);
    expect(rules.keepResp.has("id")).toBe(true);
  });
});

describe("compileFieldRules status-scoped rules", () => {
  it("compiles a resp:200 keep rule", () => {
    const rules = compileFieldRules([{ path: "resp:200.order_id", action: "keep" }]);
    expect(hasScoped(rules.keepRespStatus, 200, "order_id")).toBe(true);
  });

  it("compiles a resp:404 mask rule", () => {
    const rules = compileFieldRules([{ path: "resp:404.error", action: "mask" }]);
    expect(hasScoped(rules.maskRespStatus, 404, "error")).toBe(true);
  });

  it("compiles a resp_header:429 keep rule", () => {
    const rules = compileFieldRules([{ path: "resp_header:429.retry-after", action: "keep" }]);
    expect(hasScoped(rules.keepRespHeaderStatus, 429, "retry-after")).toBe(true);
  });

  it("compiles a resp_header:500 mask rule", () => {
    const rules = compileFieldRules([{ path: "resp_header:500.x-trace-id", action: "mask" }]);
    expect(hasScoped(rules.maskRespHeaderStatus, 500, "x-trace-id")).toBe(true);
  });

  it("lowercases a status-scoped header name", () => {
    const rules = compileFieldRules([{ path: "resp_header:200.X-Custom-Header", action: "keep" }]);
    expect(hasScoped(rules.keepRespHeaderStatus, 200, "x-custom-header")).toBe(true);
  });

  it("accepts status 100", () => {
    const rules = compileFieldRules([{ path: "resp:100.x", action: "keep" }]);
    expect(hasScoped(rules.keepRespStatus, 100, "x")).toBe(true);
  });

  it("accepts status 599", () => {
    const rules = compileFieldRules([{ path: "resp:599.x", action: "keep" }]);
    expect(hasScoped(rules.keepRespStatus, 599, "x")).toBe(true);
  });

  it("keeps a nested array path in a scoped rule intact", () => {
    const rules = compileFieldRules([{ path: "resp:200.items.[].id", action: "keep" }]);
    expect(hasScoped(rules.keepRespStatus, 200, "items.[].id")).toBe(true);
  });

  it("does not put resp:404.x in the header rules", () => {
    const rules = compileFieldRules([{ path: "resp:404.x", action: "keep" }]);
    expect(hasScoped(rules.keepRespStatus, 404, "x")).toBe(true);
    expect(rules.keepRespHeaderStatus).toHaveLength(0);
  });

  it("does not put resp_header:429 in the body rules", () => {
    const rules = compileFieldRules([{ path: "resp_header:429.retry-after", action: "keep" }]);
    expect(hasScoped(rules.keepRespHeaderStatus, 429, "retry-after")).toBe(true);
    expect(rules.keepRespStatus).toHaveLength(0);
  });

  it.each([
    ["a non-digit status", "resp:abc.x"],
    ["a one-digit status", "resp:1.x"],
    ["a two-digit status", "resp:99.x"],
    ["status 600", "resp:600.x"],
    ["a four-digit status with a leading zero", "resp:0404.x"],
    ["no subpath", "resp:404"],
    ["an empty subpath", "resp:404."],
    ["superscript digits", "resp:²²².error"],
    ["Arabic-Indic digits", "resp:٤٠٤.error"],
  ])("ignores %s", (_name, path) => {
    expect(compileFieldRules([{ path, action: "keep" }]).keepRespStatus).toHaveLength(0);
  });

  it("never raises for malformed scopes in one list", () => {
    const rules = compileFieldRules([
      { path: "resp:abc.x", action: "keep" },
      { path: "resp:1.x", action: "keep" },
      { path: "resp:99.x", action: "keep" },
      { path: "resp:600.x", action: "keep" },
      { path: "resp:0404.x", action: "keep" },
      { path: "resp:404", action: "keep" },
      { path: "resp:404.", action: "keep" },
    ]);
    expect(rules.keepRespStatus).toHaveLength(0);
  });
});
