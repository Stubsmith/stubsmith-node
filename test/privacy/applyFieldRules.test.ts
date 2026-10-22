import { describe, expect, it } from "vitest";
import { applyFieldRules, applyRespFieldRules, compileFieldRules } from "../../src/privacy/fieldRules.js";
import { HEADER_ALLOWLIST } from "../../src/privacy/masking.js";

const JSON_CT = "application/json";
const FORM_CT = "application/x-www-form-urlencoded";

function parsed(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe("applyFieldRules", () => {
  it("masks an unknown key: strings to <masked>, numbers to 0", () => {
    const compiled = compileFieldRules([]);
    const body = JSON.stringify({ secret: "sensitive", amount: 99 });
    const [masked] = applyFieldRules(body, {}, "", JSON_CT, compiled);
    const obj = JSON.parse(masked) as Record<string, unknown>;
    expect(obj["secret"]).toBe("<masked>");
    expect(obj["amount"]).toBe(0);
  });

  it("keeps a kept body field and masks the others", () => {
    const compiled = compileFieldRules([{ path: "body.amount", action: "keep" }]);
    const body = JSON.stringify({ secret: "sensitive", amount: 99 });
    const [masked] = applyFieldRules(body, {}, "", JSON_CT, compiled);
    const obj = JSON.parse(masked) as Record<string, unknown>;
    expect(obj["amount"]).toBe(99);
    expect(obj["secret"]).toBe("<masked>");
  });

  it("keeps only the named leaf of a nested path", () => {
    const compiled = compileFieldRules([{ path: "body.user.name", action: "keep" }]);
    const body = JSON.stringify({ user: { name: "alice", email: "alice@example.com" } });
    const [masked] = applyFieldRules(body, {}, "", JSON_CT, compiled);
    const obj = JSON.parse(masked) as { user: Record<string, unknown> };
    expect(obj.user["name"]).toBe("alice");
    expect(obj.user["email"]).toBe("<masked>");
  });

  it("applies an array element keep path to every element", () => {
    const compiled = compileFieldRules([{ path: "body.items.[].price", action: "keep" }]);
    const body = JSON.stringify({
      items: [
        { price: 10, secret: "x" },
        { price: 20, secret: "y" },
      ],
    });
    const [masked] = applyFieldRules(body, {}, "", JSON_CT, compiled);
    const obj = JSON.parse(masked) as { items: Array<Record<string, unknown>> };
    expect(obj.items[0]?.["price"]).toBe(10);
    expect(obj.items[0]?.["secret"]).toBe("<masked>");
    expect(obj.items[1]?.["price"]).toBe(20);
  });

  it("keeps a kept query parameter and masks the others", () => {
    const compiled = compileFieldRules([{ path: "query.page", action: "keep" }]);
    const [, , mq] = applyFieldRules("{}", { "Content-Type": JSON_CT }, "page=3&secret=abc", JSON_CT, compiled);
    expect(parsed(mq).getAll("page")).toEqual(["3"]);
    expect(parsed(mq).getAll("secret")).toEqual(["<masked>"]);
  });

  it("masks every value of a repeated query parameter by default", () => {
    const compiled = compileFieldRules([]);
    const [, , mq] = applyFieldRules("{}", {}, "a=1&a=2&b=3", JSON_CT, compiled);
    expect(parsed(mq).getAll("a").every((v) => v === "<masked>")).toBe(true);
    expect(parsed(mq).getAll("b").every((v) => v === "<masked>")).toBe(true);
  });

  it("keeps every value of a kept repeated query parameter", () => {
    const compiled = compileFieldRules([{ path: "query.a", action: "keep" }]);
    const [, , mq] = applyFieldRules("{}", {}, "a=1&a=2&b=3", JSON_CT, compiled);
    expect(new Set(parsed(mq).getAll("a"))).toEqual(new Set(["1", "2"]));
    expect(parsed(mq).getAll("b")).toEqual(["<masked>"]);
  });

  it("keeps allowlisted headers and masks other headers when there are no rules", () => {
    const compiled = compileFieldRules([]);
    const [, mh] = applyFieldRules("{}", { "content-type": JSON_CT, "x-secret": "tok" }, "", JSON_CT, compiled);
    expect(mh.get("content-type")).toBe(JSON_CT);
    expect(mh.get("x-secret")).toBe("<masked>");
  });

  it("keeps a header with a keep rule while authorization stays masked", () => {
    const compiled = compileFieldRules([{ path: "header.x-request-id", action: "keep" }]);
    const [, mh] = applyFieldRules("{}", { "x-request-id": "req-123", authorization: "Bearer tok" }, "", JSON_CT, compiled);
    expect(mh.get("x-request-id")).toBe("req-123");
    expect(mh.get("authorization")).toBe("<masked>");
  });

  it("fully masks a form body with no rules", () => {
    const compiled = compileFieldRules([]);
    const [masked] = applyFieldRules("username=alice&password=s3cr3t", {}, "", FORM_CT, compiled);
    expect(parsed(masked).getAll("username")).toEqual(["<masked>"]);
    expect(parsed(masked).getAll("password")).toEqual(["<masked>"]);
  });

  it("keeps a form field with a keep rule", () => {
    const compiled = compileFieldRules([{ path: "body.username", action: "keep" }]);
    const [masked] = applyFieldRules("username=alice&password=s3cr3t", {}, "", FORM_CT, compiled);
    expect(parsed(masked).getAll("username")).toEqual(["alice"]);
    expect(parsed(masked).getAll("password")).toEqual(["<masked>"]);
  });

  it("masks a body that is neither JSON nor form as <masked>", () => {
    const compiled = compileFieldRules([]);
    const [masked] = applyFieldRules("raw text", {}, "", "text/plain", compiled);
    expect(masked).toBe("<masked>");
  });

  it("leaves an empty body empty", () => {
    const compiled = compileFieldRules([]);
    const [masked] = applyFieldRules("", {}, "", JSON_CT, compiled);
    expect(masked).toBe("");
  });

  it("keeps none of the children of a kept parent", () => {
    const compiled = compileFieldRules([{ path: "body.user", action: "keep" }]);
    const body = JSON.stringify({ user: { name: "Ana", tags: ["x"], n: 2 } });
    const [masked] = applyFieldRules(body, {}, "", JSON_CT, compiled);
    expect(JSON.parse(masked)).toEqual({ user: { name: "<masked>", tags: ["<masked>"], n: 0 } });
  });

  it("sends a kept email and card number as they are", () => {
    const compiled = compileFieldRules([{ path: "body.note", action: "keep" }]);
    const body = JSON.stringify({ note: "ana@example.com 4111 1111 1111 1111", other: "x" });
    const [masked] = applyFieldRules(body, {}, "", JSON_CT, compiled);
    expect(JSON.parse(masked)).toEqual({ note: "ana@example.com 4111 1111 1111 1111", other: "<masked>" });
  });

  it("masks a boolean to false", () => {
    const compiled = compileFieldRules([]);
    const [masked] = applyFieldRules(JSON.stringify({ active: true }), {}, "", JSON_CT, compiled);
    expect((JSON.parse(masked) as Record<string, unknown>)["active"]).toBe(false);
  });

  it("keeps null as null", () => {
    const compiled = compileFieldRules([{ path: "body.score", action: "keep" }]);
    const [masked] = applyFieldRules(JSON.stringify({ score: null }), {}, "", JSON_CT, compiled);
    expect((JSON.parse(masked) as Record<string, unknown>)["score"]).toBeNull();
  });
});

describe("applyRespFieldRules header independence", () => {
  it("keeps a header with a resp_header keep rule", () => {
    const compiled = compileFieldRules([{ path: "resp_header.x-trace-id", action: "keep" }]);
    const [, masked] = applyRespFieldRules("{}", { "x-trace-id": "trace-abc", authorization: "Bearer tok" }, JSON_CT, compiled, undefined);
    expect(masked.get("x-trace-id")).toBe("trace-abc");
    expect(masked.get("authorization")).toBe("<masked>");
  });

  it("does not let a request header keep keep the same-named response header", () => {
    const compiled = compileFieldRules([{ path: "header.authorization", action: "keep" }]);
    const [, masked] = applyRespFieldRules("{}", { authorization: "Bearer resp-secret" }, JSON_CT, compiled, undefined);
    expect(masked.get("authorization")).toBe("<masked>");
  });

  it("does not let a resp_header keep affect the request header", () => {
    const compiled = compileFieldRules([{ path: "resp_header.authorization", action: "keep" }]);
    const [, reqMasked] = applyFieldRules("{}", { authorization: "Bearer req-secret" }, "", JSON_CT, compiled);
    expect(reqMasked.get("authorization")).toBe("<masked>");
  });

  it("keeps the request side and masks the response side for a request header keep", () => {
    const compiled = compileFieldRules([{ path: "header.authorization", action: "keep" }]);
    const [, reqMasked] = applyFieldRules("{}", { authorization: "Bearer req-tok" }, "", JSON_CT, compiled);
    const [, respMasked] = applyRespFieldRules("{}", { authorization: "Bearer resp-tok" }, JSON_CT, compiled, undefined);
    expect(reqMasked.get("authorization")).toBe("Bearer req-tok");
    expect(respMasked.get("authorization")).toBe("<masked>");
  });

  it("keeps the response side and masks the request side for a response header keep", () => {
    const compiled = compileFieldRules([{ path: "resp_header.authorization", action: "keep" }]);
    const [, reqMasked] = applyFieldRules("{}", { authorization: "Bearer req-tok" }, "", JSON_CT, compiled);
    const [, respMasked] = applyRespFieldRules("{}", { authorization: "Bearer resp-tok" }, JSON_CT, compiled, undefined);
    expect(reqMasked.get("authorization")).toBe("<masked>");
    expect(respMasked.get("authorization")).toBe("Bearer resp-tok");
  });

  it("masks a response header that is not allowlisted by default", () => {
    const compiled = compileFieldRules([]);
    const [, masked] = applyRespFieldRules("{}", { "x-internal-token": "secret123" }, JSON_CT, compiled, undefined);
    expect(masked.get("x-internal-token")).toBe("<masked>");
  });

  it("passes an allowlisted response header without a rule", () => {
    const compiled = compileFieldRules([]);
    expect(HEADER_ALLOWLIST.has("content-type")).toBe(true);
    const [, masked] = applyRespFieldRules("{}", { "content-type": JSON_CT, "x-secret": "tok" }, JSON_CT, compiled, undefined);
    expect(masked.get("content-type")).toBe(JSON_CT);
    expect(masked.get("x-secret")).toBe("<masked>");
  });
});

describe("applyRespFieldRules status-scoped rules", () => {
  it("lets a scoped keep add a field that the generic set lacks", () => {
    const rules = compileFieldRules([
      { path: "resp.order_id", action: "keep" },
      { path: "resp:200.amount", action: "keep" },
    ]);
    const body = JSON.stringify({ order_id: "ord-1", amount: 99, token: "secret" });
    const [masked] = applyRespFieldRules(body, {}, JSON_CT, rules, 200);
    const obj = JSON.parse(masked) as Record<string, unknown>;
    expect(obj["order_id"]).toBe("ord-1");
    expect(obj["amount"]).toBe(99);
    expect(obj["token"]).toBe("<masked>");
  });

  it("lets a scoped mask override a generic keep", () => {
    const rules = compileFieldRules([
      { path: "resp.customer_email", action: "keep" },
      { path: "resp:200.customer_email", action: "mask" },
    ]);
    const body = JSON.stringify({ customer_email: "alice@example.com", id: "ord-1" });
    const [masked] = applyRespFieldRules(body, {}, JSON_CT, rules, 200);
    expect((JSON.parse(masked) as Record<string, unknown>)["customer_email"]).toBe("<masked>");
  });

  it("has no effect for a scoped keep at another status", () => {
    const rules = compileFieldRules([{ path: "resp:404.error", action: "keep" }]);
    const body = JSON.stringify({ error: "something", id: 1 });
    const [masked] = applyRespFieldRules(body, {}, JSON_CT, rules, 200);
    const obj = JSON.parse(masked) as Record<string, unknown>;
    expect(obj["error"]).toBe("<masked>");
    expect(obj["id"]).toBe(0);
  });

  it("applies only the generic rules when the status is null", () => {
    const rules = compileFieldRules([
      { path: "resp.id", action: "keep" },
      { path: "resp:404.error", action: "keep" },
    ]);
    const body = JSON.stringify({ id: "abc", error: "not_found" });
    const [masked] = applyRespFieldRules(body, {}, JSON_CT, rules, null);
    const obj = JSON.parse(masked) as Record<string, unknown>;
    expect(obj["id"]).toBe("abc");
    expect(obj["error"]).toBe("<masked>");
  });

  it("behaves like no status when the status is omitted", () => {
    const rules = compileFieldRules([
      { path: "resp.id", action: "keep" },
      { path: "resp:200.extra", action: "keep" },
    ]);
    const body = JSON.stringify({ id: "abc", extra: "val" });
    const [masked] = applyRespFieldRules(body, {}, JSON_CT, rules, undefined);
    const obj = JSON.parse(masked) as Record<string, unknown>;
    expect(obj["id"]).toBe("abc");
    expect(obj["extra"]).toBe("<masked>");
  });

  it("gives the same output with and without a status when only generic rules exist", () => {
    const rules = compileFieldRules([
      { path: "resp.id", action: "keep" },
      { path: "resp.status", action: "keep" },
      { path: "resp_header.x-trace-id", action: "keep" },
    ]);
    const body = JSON.stringify({ id: "ord-1", status: "created", token: "secret" });
    const headers = { "x-trace-id": "trace-abc", "set-cookie": "sess=x", "content-type": JSON_CT };
    const [mbWith, mhWith] = applyRespFieldRules(body, headers, JSON_CT, rules, 200);
    const [mbNone, mhNone] = applyRespFieldRules(body, headers, JSON_CT, rules, null);
    expect(JSON.parse(mbWith)).toEqual(JSON.parse(mbNone));
    expect(mhWith).toEqual(mhNone);
    const obj = JSON.parse(mbWith) as Record<string, unknown>;
    expect(obj["id"]).toBe("ord-1");
    expect(obj["status"]).toBe("created");
    expect(obj["token"]).toBe("<masked>");
  });

  it("applies a scoped header keep at its status", () => {
    const rules = compileFieldRules([{ path: "resp_header:429.retry-after", action: "keep" }]);
    const headers = { "retry-after": "60", "x-secret": "hidden", "content-type": JSON_CT };
    const [, mh] = applyRespFieldRules("", headers, "", rules, 429);
    expect(mh.get("retry-after")).toBe("60");
    expect(mh.get("x-secret")).toBe("<masked>");
    expect(mh.get("content-type")).toBe(JSON_CT);
  });

  it("lets a scoped header mask override a generic header keep", () => {
    const rules = compileFieldRules([
      { path: "resp_header.x-trace-id", action: "keep" },
      { path: "resp_header:500.x-trace-id", action: "mask" },
    ]);
    const [, mh] = applyRespFieldRules("", { "x-trace-id": "trace-abc", "content-type": JSON_CT }, "", rules, 500);
    expect(mh.get("x-trace-id")).toBe("<masked>");
  });

  it("has no effect for a scoped header keep at another status", () => {
    const rules = compileFieldRules([{ path: "resp_header:429.retry-after", action: "keep" }]);
    const [, mh] = applyRespFieldRules("", { "retry-after": "60", "content-type": JSON_CT }, "", rules, 200);
    expect(mh.get("retry-after")).toBe("<masked>");
  });

  it("keeps set-cookie masked when its keep is scoped to the wrong status", () => {
    const rules = compileFieldRules([{ path: "resp_header:401.set-cookie", action: "keep" }]);
    const headers = { "set-cookie": "session=abc; HttpOnly", "content-type": JSON_CT };
    const [, mh] = applyRespFieldRules("", headers, "", rules, 200);
    expect(mh.get("set-cookie")).toBe("<masked>");
  });

  it("unmasks set-cookie with a matching scoped keep", () => {
    const rules = compileFieldRules([{ path: "resp_header:401.set-cookie", action: "keep" }]);
    const headers = { "set-cookie": "session=abc; HttpOnly", "content-type": JSON_CT };
    const [, mh] = applyRespFieldRules("", headers, "", rules, 401);
    expect(mh.get("set-cookie")).toBe("session=abc; HttpOnly");
  });

  it("unmasks a non-credential header with a matching scoped keep", () => {
    const rules = compileFieldRules([{ path: "resp_header:200.x-trace-id", action: "keep" }]);
    const [, mh] = applyRespFieldRules("", { "x-trace-id": "trace-abc", "content-type": JSON_CT }, "", rules, 200);
    expect(mh.get("x-trace-id")).toBe("trace-abc");
  });

  it("masks the body field when a path is both kept and masked for one status", () => {
    const rules = compileFieldRules([
      { path: "resp:200.name", action: "keep" },
      { path: "resp:200.name", action: "mask" },
    ]);
    const body = JSON.stringify({ name: "Alice", id: 1 });
    const [masked] = applyRespFieldRules(body, {}, JSON_CT, rules, 200);
    expect((JSON.parse(masked) as Record<string, unknown>)["name"]).toBe("<masked>");
  });
});
