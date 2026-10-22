import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyPipeline } from "../../src/privacy/pipeline.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { toJsonValue } from "../helpers/vectors.js";

// Dummy values only. Project defaults carry field_masks in mixed case and padded on purpose.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env["STUBSMITH_MASK_SALT"];
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Input = Parameters<PrivacyPipeline["process"]>[0];

/** Sync a rule for `input`'s fingerprint that keeps `keeps`, then run the real pipeline on `input`. */
function run(input: Input, keeps: string[], fieldMasks: string[] = ["password", " X-Password "]): ReturnType<PrivacyPipeline["process"]> {
  const fp = new PrivacyPipeline(new RulesCache()).process(input)?.req_fingerprint as string;
  const cache = new RulesCache();
  cache.applySyncResponse(
    toJsonValue({
      cursor: "1",
      rules: [
        {
          fingerprint: fp,
          request_type: { domain: "api.example.com", method: input.method.toUpperCase(), path_template: "/v1/login" },
          field_rules: keeps.map((path) => ({ path, action: "keep" })),
        },
      ],
      project_defaults: { field_masks: fieldMasks },
    }),
  );
  const out = new PrivacyPipeline(cache).process(input);
  expect(out?.novel).toBe(false);
  return out;
}

describe("project field_masks override field-rule keeps", () => {
  const json: Input = {
    method: "post",
    url: "http://api.example.com/v1/login?password=hunter2&page=2&user=ana",
    reqHeaders: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Password": "hunter2",
      "X-Trace": "t-1",
    },
    reqBody:
      '{"password":"hunter2","user":{"name":"ana","Password":"hunter2","nick":"ana"},' +
      '"Password":{"a":"hunter2","b":[1,true,null,{"c":"4111111111111111"}]},"plan":"pro"}',
    status: 200,
    respHeaders: { "Content-Type": "application/json", "X-Password": "hunter2", "X-Trace": "t-2" },
    respBody: '{"password":"hunter2","user":{"password":"hunter2","name":"ana"},"id":9,"pin":{"password":"hunter2"}}',
  };

  const keeps = [
    "body.password",
    "body.user.name",
    "body.user.Password",
    "body.user.nick",
    "body.Password.a",
    "body.Password.b.[]",
    "body.Password.b.[].c",
    "body.plan",
    "query.password",
    "query.page",
    "query.user",
    "header.x-password",
    "header.x-trace",
    "resp.password",
    "resp.user.password",
    "resp.user.name",
    "resp.id",
    "resp_header.x-password",
    "resp_header.x-trace",
    "resp:200.pin.password",
    "resp_header:200.x-password",
  ];

  it("masks matching names in JSON bodies (whole subtree), query and headers; other kept fields stay verbatim", () => {
    const out = run(json, keeps);
    expect({
      path: out?.path,
      headers: out?.headers,
      req_body: out?.req_body,
      resp_headers: out?.resp_headers,
      resp_body: out?.resp_body,
      novel: out?.novel,
    }).toEqual({
      path: "/v1/login?password=%3Cmasked%3E&page=2&user=ana",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Password": "<masked>",
        "X-Trace": "t-1",
      },
      req_body:
        '{"password": "<masked>", "user": {"name": "ana", "Password": "<masked>", "nick": "ana"}, ' +
        '"Password": {"a": "<masked>", "b": [0, false, null, {"c": "<masked>"}]}, "plan": "pro"}',
      resp_headers: { "Content-Type": "application/json", "X-Password": "<masked>", "X-Trace": "t-2" },
      resp_body:
        '{"password": "<masked>", "user": {"password": "<masked>", "name": "ana"}, "id": 9, "pin": {"password": "<masked>"}}',
      novel: false,
    });
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("masks matching names in form-encoded bodies", () => {
    const form: Input = {
      method: "post",
      url: "http://api.example.com/v1/login",
      reqHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
      reqBody: "password=hunter2&Password=hunter2&name=ana",
      status: 200,
      respHeaders: {},
      respBody: "",
    };
    const out = run(form, ["body.password", "body.Password", "body.name"]);
    expect(out?.req_body).toBe("password=%3Cmasked%3E&Password=%3Cmasked%3E&name=ana");
    expect(out?.novel).toBe(false);
  });

  it("leaves kept fields alone when field_masks does not name them", () => {
    const out = run(json, keeps, ["secret"]);
    expect(out?.path).toBe("/v1/login?password=hunter2&page=2&user=ana");
    expect(out?.headers["X-Password"]).toBe("hunter2");
    expect(out?.resp_body).toBe(
      '{"password": "hunter2", "user": {"password": "hunter2", "name": "ana"}, "id": 9, "pin": {"password": "hunter2"}}',
    );
  });

  it("uses the same typed placeholders as an unkept value under a forced subtree", () => {
    process.env["STUBSMITH_MASK_SALT"] = "dummy-salt";
    const input: Input = {
      ...json,
      reqBody: '{"password":{"contact":"ana@example.com","note":"hunter2"},"plan":"pro"}',
      respBody: "",
    };
    const typed = [{ path: "body.password.contact", action: "mask", type: "email" }];
    const fp = new PrivacyPipeline(new RulesCache()).process(input)?.req_fingerprint as string;
    const build = (fieldRules: unknown[]): string | undefined => {
      const cache = new RulesCache();
      cache.applySyncResponse(
        toJsonValue({
          cursor: "1",
          rules: [
            {
              fingerprint: fp,
              request_type: { domain: "api.example.com", method: "POST", path_template: "/v1/login" },
              field_rules: fieldRules,
            },
          ],
          project_defaults: { field_masks: ["password"] },
        }),
      );
      return new PrivacyPipeline(cache).process(input)?.req_body;
    };
    const unkept = build([...typed, { path: "body.plan", action: "keep" }]);
    const kept = build([...typed, { path: "body.password.note", action: "keep" }, { path: "body.plan", action: "keep" }]);
    expect(kept).toBe(unkept);
    expect(unkept).toMatch(/^\{"password": \{"contact": "[^"]+@[^"]+", "note": "<masked>"\}, "plan": "pro"\}$/);
    expect(unkept).not.toContain("ana@example.com");
    expect(unkept).not.toContain("hunter2");
  });
});
