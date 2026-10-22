import { PrivacyPipeline } from "../../src/privacy/pipeline.js";
import type { Payload, PipelineInput } from "../../src/privacy/pipeline.js";
import { RulesCache } from "../../src/privacy/rulesCache.js";
import { fingerprint } from "../../src/privacy/fingerprint.js";
import { stringifyJson } from "../../src/internal/json.js";
import { toJsonValue } from "./vectors.js";

interface SyncOptions {
  domain?: string;
  method?: string;
  pathTemplate?: string;
  cursor?: string;
  pathTemplates?: string[];
  projectDefaults?: unknown;
  valueConfig?: Record<string, string[]>;
}

/** A sync response for one rule, with the defaults of the test endpoint `POST api.example.com/v1/orders`, as plain data. */
export function syncResponseObject(fp: string, fieldRules: unknown[], o: SyncOptions = {}): Record<string, unknown> {
  const resp: Record<string, unknown> = {
    ok: true,
    cursor: o.cursor ?? "1",
    rules: [
      {
        seq: 1,
        request_type: {
          domain: o.domain ?? "api.example.com",
          method: o.method ?? "POST",
          path_template: o.pathTemplate ?? "/v1/orders",
        },
        fingerprint: fp,
        field_rules: fieldRules,
      },
    ],
    path_templates: o.pathTemplates ?? [],
  };
  if (o.projectDefaults !== undefined) resp["project_defaults"] = o.projectDefaults;
  if (o.valueConfig !== undefined) resp["request_type_value_config"] = o.valueConfig;
  return resp;
}

/** The same response as parsed JSON, for {@link RulesCache.applySyncResponse}. */
export function makeSyncResponse(fp: string, fieldRules: unknown[], o: SyncOptions = {}): ReturnType<typeof toJsonValue> {
  return toJsonValue(syncResponseObject(fp, fieldRules, o));
}

/** The same response as the JSON text a backend serves. */
export function syncResponseText(fp: string, fieldRules: unknown[], o: SyncOptions = {}): string {
  return JSON.stringify(syncResponseObject(fp, fieldRules, o));
}

/** An empty cache with its pipeline. */
export function makePipeline(): { cache: RulesCache; pipeline: PrivacyPipeline } {
  const cache = new RulesCache();
  return { cache, pipeline: new PrivacyPipeline(cache) };
}

/** A cache that has applied `sync`, with its pipeline. */
export function makeSyncedPipeline(sync: ReturnType<typeof toJsonValue>): { cache: RulesCache; pipeline: PrivacyPipeline } {
  const { cache, pipeline } = makePipeline();
  cache.applySyncResponse(sync);
  return { cache, pipeline };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Run one exchange through `pipeline`. Unset fields take the defaults of the test endpoint. */
export function callProcess(pipeline: PrivacyPipeline, over: Partial<PipelineInput> = {}): Payload | null {
  return pipeline.process({
    method: "POST",
    url: "https://api.example.com/v1/orders",
    reqHeaders: JSON_HEADERS,
    reqBody: '{"user": {"email": "alice@example.com"}, "amount": 99}',
    status: 200,
    respHeaders: JSON_HEADERS,
    respBody: '{"id": 1, "status": "ok"}',
    ...over,
  });
}

/** Request fingerprint of `reqBody` as the pipeline computes it for the default endpoint. */
export function reqFingerprint(reqBody: string, query = "", contentType = "application/json"): string {
  return fingerprint(reqBody, query, contentType);
}

/** A non-null payload, for tests that go on to read fields. */
export function mustPayload(p: Payload | null): Payload {
  if (p === null) throw new Error("pipeline returned null");
  return p;
}

/** `json.dumps` layout (`", "` and `": "` separators) of a plain value. */
export function dumps(value: unknown): string {
  return stringifyJson(toJsonValue(value));
}

/** A JSON document of `n` items, in `json.dumps` layout. */
export function bigJson(n = 3000): string {
  const items = Array.from({ length: n }, (_, i) => `{"sku": "S${String(i).padStart(6, "0")}", "qty": ${i}}`);
  return `{"items": [${items.join(", ")}]}`;
}
