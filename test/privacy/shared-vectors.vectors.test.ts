import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../src/_version.js";
import { isJsonNumber, parseJson } from "../../src/internal/json.js";
import type { JsonValue } from "../../src/internal/json.js";
import { pyFloatStr } from "../../src/internal/pyfloat.js";
import { parseForm } from "../../src/internal/pyqs.js";
import { isImage, placeholderFor } from "../../src/privacy/binary.js";
import { applyFieldRules, applyRespFieldRules, compileFieldRules } from "../../src/privacy/fieldRules.js";
import { classifyScalar, extractKeypaths, extractValueTypes } from "../../src/privacy/fingerprint.js";
import { compileRules, maskAll, maskKnown, resetMaskingWarningsForTests } from "../../src/privacy/masking.js";
import type { CompiledRules } from "../../src/privacy/masking.js";
import { PrivacyPipeline } from "../../src/privacy/pipeline.js";
import { generate, getSalt } from "../../src/privacy/placeholders.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { RulesPoller } from "../../src/sync.js";
import { expandLong, fromTyped, loadVectors, plain, toJsonValue } from "../helpers/vectors.js";
import type { TypedScalar } from "../helpers/vectors.js";

// The masking and fail-closed vector files are authored in the Python SDK and copied here byte for byte.
// Each case names an operation; the files' descriptions say what each operation takes and returns.
interface Case {
  name: string;
  op: string;
  input: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  expected: unknown;
}

const FILES = ["masking-vectors.json", "masking-pipeline-vectors.json", "masking-values-vectors.json", "fail-closed-vectors.json"];

type Dict = Record<string, unknown>;

function withSalt<T>(salt: string | null, fn: () => T): T {
  const old = process.env["STUBSMITH_MASK_SALT"];
  if (salt) process.env["STUBSMITH_MASK_SALT"] = salt;
  else delete process.env["STUBSMITH_MASK_SALT"];
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env["STUBSMITH_MASK_SALT"];
    else process.env["STUBSMITH_MASK_SALT"] = old;
  }
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const scoped = (pairs: readonly (readonly [number, string])[]): Array<[number, string]> =>
  pairs.map(([s, p]): [number, string] => [s, p]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

function extraRules(pd: { field_masks: unknown; regex_masks: unknown } | null): CompiledRules | null {
  return pd === null ? null : compileRules(toJsonValue(pd.field_masks), toJsonValue(pd.regex_masks));
}

function toTyped(v: JsonValue): TypedScalar {
  if (typeof v === "string") return { type: "str", value: v };
  if (typeof v === "boolean") return { type: "bool", value: v };
  if (v === null) return { type: "none" };
  if (isJsonNumber(v)) return v.isFloat ? { type: "float", text: pyFloatStr(v.raw) } : { type: "int", text: v.raw === "-0" ? "0" : v.raw };
  throw new Error("container");
}

/** The rules cache after the polls, with the real poller answering from the script instead of the network. */
async function syncedCache(polls: Array<{ status: number; body: unknown }>): Promise<RulesCache> {
  const cache = new RulesCache();
  const poller = new RulesPoller(cache, { apiKey: "sk-test", backendUrl: "http://fake", intervalMs: 3_600_000 });
  const script = polls.map((p) => ({ status: p.status, body: p.body === null ? null : toJsonValue(p.body) }));
  (poller as unknown as { get: () => Promise<unknown> }).get = () => Promise.resolve(script.shift());
  for (let n = 0; n < polls.length; n++) await poller.pollOnce();
  return cache;
}

async function runOp(op: string, i: Case["input"]): Promise<unknown> {
  switch (op) {
    case "compile_field_rules": {
      const c = compileFieldRules(toJsonValue(i["field_rules"]));
      return {
        keep_body: sorted(c.keepBody),
        keep_query: sorted(c.keepQuery),
        keep_header: sorted(c.keepHeader),
        keep_resp: sorted(c.keepResp),
        keep_resp_header: sorted(c.keepRespHeader),
        keep_resp_status: scoped(c.keepRespStatus),
        mask_resp_status: scoped(c.maskRespStatus),
        keep_resp_header_status: scoped(c.keepRespHeaderStatus),
        mask_resp_header_status: scoped(c.maskRespHeaderStatus),
        body_mask_types: Object.fromEntries(c.bodyMaskTypes),
        query_mask_types: Object.fromEntries(c.queryMaskTypes),
        resp_mask_types: Object.fromEntries(c.respMaskTypes),
      };
    }
    case "apply_field_rules": {
      const compiled = compileFieldRules(toJsonValue(i["field_rules"]));
      const opts = { extraRules: extraRules(i["project_defaults"]), emailDomain: i["email_domain"] as string | null };
      const [body, headers, query] = withSalt(i["salt"], () =>
        applyFieldRules(i["body"], i["headers"], i["query"], i["content_type"], compiled, opts),
      );
      return { body, headers: Object.fromEntries(headers), query };
    }
    case "apply_resp_field_rules": {
      const compiled = compileFieldRules(toJsonValue(i["field_rules"]));
      const opts = { extraRules: extraRules(i["project_defaults"]), emailDomain: i["email_domain"] as string | null };
      const [body, headers] = withSalt(i["salt"], () =>
        applyRespFieldRules(i["body"], i["headers"], i["content_type"], compiled, i["resp_status"], opts),
      );
      return { body, headers: Object.fromEntries(headers) };
    }
    case "compile_and_mask": {
      const rules = compileRules(toJsonValue(i["field_masks"]), toJsonValue(i["regex_masks"]));
      const [body, headers, query] = maskKnown(i["body"], i["headers"], i["query"], i["content_type"], rules);
      return {
        rules: {
          unusable: rules.unusable,
          field_masks: sorted(rules.fieldMasks),
          regex_replacements: rules.regexMasks.map((m) => m.replace),
        },
        body,
        headers: Object.fromEntries(headers),
        query,
      };
    }
    case "mask_all": {
      const [body, headers, query] = maskAll(i["body"], i["headers"], i["query"], i["content_type"]);
      return { body, headers: Object.fromEntries(headers), query };
    }
    case "parse_form": {
      const form = parseForm(i["body"]);
      return { result: form === null ? null : Object.fromEntries(form) };
    }
    case "binary_placeholder": {
      const image = isImage(i["content_type"]);
      if (!image) return { is_image: false, subtype: null, data_base64: null };
      const { bytes, subtype } = placeholderFor(i["content_type"]);
      return { is_image: true, subtype, data_base64: Buffer.from(bytes).toString("base64") };
    }
    case "pipeline_process": {
      const salt = i["salt"] as string | null;
      const cache = await withSalt(salt, () => syncedCache(i["polls"]));
      let payload: Dict | null = null;
      const r = i["request"];
      if (r !== null) {
        const out = withSalt(salt, () =>
          new PrivacyPipeline(cache).process({
            method: r.method,
            url: r.url,
            reqHeaders: r.req_headers,
            reqBody: r.req_body,
            status: r.resp_status,
            respHeaders: r.resp_headers,
            respBody: r.resp_body,
          }),
        );
        if (out !== null) {
          payload = plain<Dict>(out);
          // The vectors leave sdk_version out; each SDK checks its own.
          expect(payload["sdk_version"]).toBe(VERSION);
          delete payload["sdk_version"];
        }
      }
      const defaults = cache.projectDefaults;
      return {
        payload,
        cache: {
          cursor: cache.cursor,
          first_sync_done: cache.firstSyncDone,
          project_defaults:
            defaults === null
              ? null
              : { field_masks: sorted(defaults.fieldMasks), regex_count: defaults.regexMasks.length, unusable: defaults.unusable },
        },
      };
    }
    case "placeholder": {
      const key = withSalt(i["salt"], () => getSalt());
      const outputs = (i["values"] as TypedScalar[]).map((v) => {
        const once = () => generate(i["semantic_type"], fromTyped(v), { salt: key, emailDomain: i["email_domain"] });
        const first = toTyped(once());
        expect(toTyped(once())).toEqual(first);
        return first;
      });
      return { salt_key_hex: key === null ? null : Buffer.from(key).toString("hex"), outputs };
    }
    case "classify_scalar":
      return { label: classifyScalar(parseJson(i["json"] as string)) };
    case "extract_keypaths":
      return { key_paths: extractKeypaths(i["body"], i["content_type"]) };
    case "extract_value_types":
      return { value_types: plain(extractValueTypes(i["body"], i["content_type"])) };
    default:
      throw new Error(`unknown op ${op}`);
  }
}

describe.each(FILES)("%s", (name) => {
  const file = loadVectors<Case["input"], unknown>(name) as unknown as { cases: Case[] };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetMaskingWarningsForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetMaskingWarningsForTests();
  });

  it("has uniquely named cases", () => {
    const names = file.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(file.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const actual = await runOp(c.op, expandLong(c.input));
    expect(actual).toStrictEqual(expandLong(c.expected));
  });
});
