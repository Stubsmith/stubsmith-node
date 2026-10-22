import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompiledFieldRules, applyFieldRules, compileFieldRules } from "../../src/privacy/fieldRules.js";
import { templatePath } from "../../src/privacy/templating.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { toJsonValue } from "../helpers/vectors.js";

const sync = (o: unknown): ReturnType<typeof toJsonValue> => toJsonValue(o);
const rule = (fp: string, path = "/a") => ({
  fingerprint: fp,
  request_type: { domain: "h", method: "get", path_template: path },
  field_rules: [{ path: "body.x", action: "keep" }],
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("RulesCache.applySyncResponse", () => {
  it("starts empty", () => {
    const c = new RulesCache();
    expect(c.cursor).toBe("0");
    expect(c.emailDomain).toBe("stub.invalid");
    expect(c.firstSyncDone).toBe(false);
    expect(c.projectDefaults).toBeNull();
    expect(c.lookup("h|GET|/a", "f1")).toBeNull();
  });

  it("is additive, skips empty fingerprints and upper-cases the method", () => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ cursor: "3", rules: [rule("f1"), rule("")] }));
    c.applySyncResponse(sync({ cursor: "4", rules: [rule("f2")] }));
    expect(c.lookup("h|GET|/a", "f1")).toBeInstanceOf(CompiledFieldRules);
    expect(c.lookup("h|GET|/a", "f2")).toBeInstanceOf(CompiledFieldRules);
    expect(c.lookup("h|GET|/a", "")).toBeNull();
    expect(c.cursor).toBe("4");
    expect(c.firstSyncDone).toBe(true);
  });

  it("keeps the cursor when the response cursor is 0 or absent; accepts a numeric cursor", () => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ cursor: 7 }));
    expect(c.cursor).toBe("7");
    c.applySyncResponse(sync({ cursor: "0" }));
    c.applySyncResponse(sync({}));
    expect(c.cursor).toBe("7");
  });

  it("replaces path templates and value config wholesale; absent value config is untouched", () => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ path_templates: ["/a/{id}"], request_type_value_config: { "h|GET|/a": ["k", 5] } }));
    expect(c.pathTemplates.map((t) => t.template)).toEqual(["/a/{id}"]);
    expect(c.getValuePaths("h|GET|/a")).toEqual(["k"]);
    c.applySyncResponse(sync({}));
    expect(c.pathTemplates).toEqual([]);
    expect(c.getValuePaths("h|GET|/a")).toEqual(["k"]);
    c.applySyncResponse(sync({ request_type_value_config: {} }));
    expect(c.getValuePaths("h|GET|/a")).toEqual([]);
  });

  it("stores project defaults only when they compile to a rule; email domain only when non-empty", () => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ project_defaults: { regex_masks: [], email_placeholder_domain: "x.invalid" } }));
    expect(c.projectDefaults).toBeNull();
    expect(c.emailDomain).toBe("x.invalid");
    c.applySyncResponse(sync({ project_defaults: { field_masks: ["a"], email_placeholder_domain: "" } }));
    expect(c.projectDefaults?.fieldMasks.has("a")).toBe(true);
    expect(c.emailDomain).toBe("x.invalid");
    // a later sync without project_defaults keeps what was stored
    c.applySyncResponse(sync({}));
    expect(c.projectDefaults?.fieldMasks.has("a")).toBe(true);
  });

  it.each([[[]], ["rules"], [5]])("stores project_defaults that is not an object (%j) as unusable", (pd) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = new RulesCache();
    c.applySyncResponse(sync({ cursor: "9", project_defaults: pd }));
    expect(c.cursor).toBe("9");
    expect(c.projectDefaults?.unusable).toBe(true);
    const keep = compileFieldRules(sync([{ path: "body.note", action: "keep" }, { path: "body.n", action: "keep" }]));
    const [body] = applyFieldRules('{"note":"hello","n":1}', {}, "", "application/json", keep, { extraRules: c.projectDefaults, salt: null });
    expect(body).toBe('{"note": "<masked>", "n": 1}');
    vi.restoreAllMocks();
  });

  it("leaves absent or null project_defaults as none", () => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ project_defaults: null }));
    expect(c.projectDefaults).toBeNull();
  });

  it("stores malformed project_defaults as unusable without aborting the merge", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = new RulesCache();
    c.applySyncResponse(sync({ cursor: "9", project_defaults: { field_masks: [1, "pw"] } }));
    expect(c.cursor).toBe("9");
    expect(c.projectDefaults?.unusable).toBe(true);
    expect(c.projectDefaults?.fieldMasks.has("pw")).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("RulesCache fail-closed divergences", () => {
  it.each(["(?i:x)", "bad("])("stores a project default whose only pattern %j cannot be used, so kept strings are masked", (pattern) => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ project_defaults: { regex_masks: [{ pattern, replace: "y" }] } }));
    expect(c.projectDefaults?.unusable).toBe(true);
  });
});

describe("RulesCache.applySyncResponse input validation", () => {
  it.each([null, [], "str", 5, true])("ignores a non-object body (%j) without any state change", (body) => {
    const fresh = new RulesCache();
    fresh.applySyncResponse(body);
    expect(fresh.firstSyncDone).toBe(false);
    expect(fresh.cursor).toBe("0");
  });

  it("skips rules with non-string request_type parts instead of throwing or stringifying", () => {
    const c = new RulesCache();
    const good = rule("good");
    c.applySyncResponse(
      sync({
        rules: [
          { ...rule("n1"), request_type: { domain: 1, method: "get", path_template: "/a" } },
          { ...rule("n2"), request_type: { domain: "h", method: 5, path_template: "/a" } },
          { ...rule("n3"), request_type: { domain: "h", method: "get", path_template: ["x"] } },
          { ...rule("n4"), request_type: "oops" },
          { ...rule("n5"), field_rules: [{ path: 7, action: "keep" }] },
          good,
        ],
      }),
    );
    expect(c.lookup("h|GET|/a", "good")).toBeInstanceOf(CompiledFieldRules);
    for (const fp of ["n1", "n2", "n3", "n4", "n5"]) expect(c.lookup("h|GET|/a", fp)).toBeNull();
    expect(c.lookup("1|GET|/a", "n1")).toBeNull();
    expect(c.lookup("h|5|/a", "n2")).toBeNull();
    expect(c.lookup("h|GET|[\"x\"]", "n3")).toBeNull();
  });

  it("skips a numeric fingerprint, so it never matches", () => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ rules: [{ ...rule("x"), fingerprint: 123 }, rule("ok")] }));
    expect(c.lookup("h|GET|/a", "123")).toBeNull();
    expect(c.lookup("h|GET|/a", "ok")).toBeInstanceOf(CompiledFieldRules);
  });
});

describe("curated templates", () => {
  it("pathTemplates is a stable frozen array between syncs and still matches", () => {
    const c = new RulesCache();
    c.applySyncResponse(sync({ path_templates: ["/a/{id}/b", "/a/x/b"] }));
    const t = c.pathTemplates;
    expect(c.pathTemplates).toBe(t);
    expect(Object.isFrozen(t)).toBe(true);
    expect(t[0]?.segments).toEqual(["a", "x", "b"]);
    expect(templatePath("/a/x/b", t)).toBe("/a/x/b");
    expect(templatePath("/a/7/b", t)).toBe("/a/{id}/b");
    c.applySyncResponse(sync({ path_templates: [] }));
    expect(c.pathTemplates).not.toBe(t);
  });
});
