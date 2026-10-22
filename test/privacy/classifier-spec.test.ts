import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as generated from "../../src/privacy/classifiers.generated.js";
import { classifyScalar, VOCAB } from "../../src/privacy/fingerprint.js";
import { SEMANTIC_TYPE_VOCAB } from "../../src/privacy/placeholders.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { loadCuratedTemplates, templatePath } from "../../src/privacy/templating.js";
import type { Bundle } from "../../src/replay/bundle.js";
import { StubNotFound } from "../../src/replay/engine.js";
import { replay } from "../../src/replay/index.js";
import { callProcess, makePipeline, syncResponseObject } from "../helpers/pipeline.js";
import { toJsonValue } from "../helpers/vectors.js";
import { DOMAIN, bundle, endpoint } from "../replay/helpers.js";

// The value-type labels and path ID rules come from the shared classifier spec.
// tools/classifiers/classifiers.json is a copy of it; generate.py turns it into
// src/privacy/classifiers.generated.ts. These tests run the spec's own examples
// against the generated code and the SDK functions that use it, check that the
// generated file matches the spec next to it, and cover the project's "Group IDs
// in paths automatically" setting in capture and replay.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SPEC_PATH = `${ROOT}tools/classifiers/classifiers.json`;
const SPEC_BYTES = fs.readFileSync(SPEC_PATH);

interface StringRule {
  label: string;
  regex: string;
  flags?: string;
  match: string[];
  no_match: string[];
}
const SPEC = JSON.parse(SPEC_BYTES.toString("utf8")) as {
  version: number;
  labels: Array<{ label: string }>;
  value_classifier: {
    json_integer: string;
    json_float: string;
    string_rules: StringRule[];
    string_fallback: string;
    fallback_examples: string[];
  };
  path_id: { match: string[]; no_match: string[] };
};
const RULES = SPEC.value_classifier.string_rules;

/** The spec regex with Python `re` semantics: `\d` is any Unicode decimal digit and `$` also matches before a trailing newline. */
function specRegex(rule: StringRule): RegExp {
  const source = rule.regex.replace(/\\d/g, "\\p{Nd}").replace(/\$/g, "(?=\\n?$)");
  return new RegExp(source, rule.flags?.includes("i") ? "ui" : "u");
}

/** The label the spec says a string gets: the first rule whose regex matches. */
function firstLabel(value: string): string {
  for (const rule of RULES) if (specRegex(rule).test(value)) return rule.label;
  return SPEC.value_classifier.string_fallback;
}

describe("generated from the spec", () => {
  it("generated file matches the spec", () => {
    const result = spawnSync("python3", ["tools/classifiers/generate.py", "--target", "node", "--root", ROOT, "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("version and digest are the spec's", () => {
    expect(generated.SPEC_VERSION).toBe(SPEC.version);
    expect(generated.SPEC_SHA256).toBe(createHash("sha256").update(SPEC_BYTES).digest("hex"));
  });

  it("vocabulary is the spec's labels, in order", () => {
    const labels = SPEC.labels.map((l) => l.label);
    expect([...generated.VOCAB]).toEqual(labels);
    expect(VOCAB).toBe(generated.VOCAB);
    expect(SEMANTIC_TYPE_VOCAB).toBe(generated.VOCAB);
  });

  it("string rules are the spec's rules, in order", () => {
    expect(generated.STRING_RULES.map(([label]) => label)).toEqual(RULES.map((r) => r.label));
  });
});

describe("spec examples", () => {
  it.each(RULES.map((r) => [r.label, r] as const))("string rule %s", (_label, rule) => {
    for (const value of rule.match) {
      expect(generated.classifyString(value), value).toBe(firstLabel(value));
      expect(classifyScalar(value), value).toBe(firstLabel(value));
    }
    // The generated rule itself does not match its no_match examples. It is found by label, so the check does not depend on rule order.
    const own = generated.STRING_RULES.find(([label]) => label === rule.label)?.[1];
    expect(own, rule.label).toBeInstanceOf(RegExp);
    for (const value of rule.match) expect(own?.test(value), value).toBe(true);
    for (const value of rule.no_match) expect(own?.test(value), value).toBe(false);
  });

  it("each match example gets its rule's label unless an earlier rule wins", () => {
    RULES.forEach((rule, index) => {
      for (const value of rule.match) {
        const earlier = RULES.slice(0, index).map((r) => r.label);
        const got = classifyScalar(value);
        expect(got === rule.label || earlier.includes(got as string), `${value}: ${String(got)}`).toBe(true);
      }
    });
  });

  it("rule order is the spec's", () => {
    expect(generated.STRING_RULES.map(([label]) => label)).toEqual(RULES.map((r) => r.label));
  });

  it("fallback examples are free_text", () => {
    for (const value of SPEC.value_classifier.fallback_examples) {
      expect(classifyScalar(value), value).toBe(SPEC.value_classifier.string_fallback);
      expect(generated.classifyString(value), value).toBe(SPEC.value_classifier.string_fallback);
    }
  });

  it("JSON numbers, booleans and null", () => {
    expect(classifyScalar(toJsonValue(42))).toBe(SPEC.value_classifier.json_integer);
    expect(classifyScalar(toJsonValue(4.2))).toBe(SPEC.value_classifier.json_float);
    expect(classifyScalar(true)).toBeNull();
    expect(classifyScalar(null)).toBeNull();
  });

  it("path ID examples", () => {
    for (const seg of SPEC.path_id.match) expect(generated.isIdSegment(seg), seg).toBe(true);
    for (const seg of SPEC.path_id.no_match) expect(generated.isIdSegment(seg), seg).toBe(false);
  });
});

describe("group IDs setting", () => {
  it("templatePath on and off", () => {
    const curated = loadCuratedTemplates(["/shops/{shop}/orders"]);
    expect(templatePath("/orders/123", curated)).toBe("/orders/{id}");
    expect(templatePath("/orders/123", curated, false)).toBe("/orders/123");
    // curated templates still group paths when the heuristic is off
    expect(templatePath("/shops/x1/orders", curated, false)).toBe("/shops/{shop}/orders");
  });
});

describe("capture group IDs", () => {
  // The setting arrives in the rules sync and decides path_template.
  const syncBody = (extra: Record<string, unknown>, cursor = "1"): ReturnType<typeof toJsonValue> =>
    toJsonValue({ ...syncResponseObject("unused", [], { cursor }), ...extra });
  const processed = (extra: Record<string, unknown>) => {
    const { cache, pipeline } = makePipeline();
    cache.applySyncResponse(syncBody(extra));
    return { cache, payload: callProcess(pipeline, { url: "https://api.example.com/v1/orders/123" }) };
  };

  it("is on by default and when the sync says so", () => {
    for (const extra of [{}, { project_settings: { group_ids_in_paths: true } }]) {
      const { cache, payload } = processed(extra);
      expect(cache.groupIdsInPaths).toBe(true);
      expect(payload?.path_template).toBe("/v1/orders/{id}");
    }
  });

  it("off sends the path as written", () => {
    const { cache, payload } = processed({ project_settings: { group_ids_in_paths: false } });
    expect(cache.groupIdsInPaths).toBe(false);
    expect(payload?.path_template).toBe("/v1/orders/123");
    expect(payload?.path).toBe("/v1/orders/123");
  });

  it("a later sync without the setting keeps it", () => {
    const { cache, pipeline } = makePipeline();
    cache.applySyncResponse(syncBody({ project_settings: { group_ids_in_paths: false } }, "1"));
    cache.applySyncResponse(syncBody({}, "2"));
    expect(cache.groupIdsInPaths).toBe(false);
    expect(callProcess(pipeline, { url: "https://api.example.com/v1/orders/123" })?.path_template).toBe("/v1/orders/123");
  });

  it("a later sync can turn it back on", () => {
    const cache = new RulesCache();
    cache.applySyncResponse(syncBody({ project_settings: { group_ids_in_paths: false } }));
    cache.applySyncResponse(syncBody({ project_settings: { group_ids_in_paths: true } }));
    expect(cache.groupIdsInPaths).toBe(true);
  });

  it.each([
    ["a string", { project_settings: { group_ids_in_paths: "false" } }],
    ["a list", { project_settings: [] }],
    ["null", { project_settings: null }],
  ])("a malformed setting (%s) leaves it as it was", (_name, body) => {
    expect(processed(body).cache.groupIdsInPaths).toBe(true);
    const cache = new RulesCache();
    cache.applySyncResponse(syncBody({ project_settings: { group_ids_in_paths: false } }));
    cache.applySyncResponse(syncBody(body));
    expect(cache.groupIdsInPaths).toBe(false);
  });

  it("payload names the classifier spec version", () => {
    expect(processed({}).payload?.classifier_spec_version).toBe(SPEC.version);
  });
});

describe("replay group IDs", () => {
  // The miss is raised through the replay hook, as a caller's request would see it.
  const missPath = async (settings: unknown): Promise<string> => {
    const b = { ...bundle(endpoint("GET", "/api/users/7", [])), ...(settings === undefined ? {} : { project_settings: settings }) };
    const r = replay({ bundle: b as Bundle });
    try {
      await fetch(`https://${DOMAIN}/api/orders/42`);
    } catch (err) {
      if (err instanceof StubNotFound) return err.pathTemplate;
      throw err;
    } finally {
      r.restore();
    }
    throw new Error("expected a miss");
  };

  it.each([
    ["no project_settings", undefined, "/api/orders/{id}"],
    ["on", { group_ids_in_paths: true }, "/api/orders/{id}"],
    ["off", { group_ids_in_paths: false }, "/api/orders/42"],
    ["not a boolean", { group_ids_in_paths: "no" }, "/api/orders/{id}"],
  ])("templates paths like capture: %s", async (_name, settings, expected) => {
    expect(await missPath(settings)).toBe(expected);
  });

  it("groups when project_settings is not an object", async () => {
    expect(await missPath("off")).toBe("/api/orders/{id}");
  });
});
