import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeFingerprint } from "../../src/privacy/fingerprint.js";
import type { Bundle, BundleEndpoint, BundleSample, BundleStub, BundleVariant } from "../../src/replay/bundle.js";

export const DOMAIN = "api.example.com";
export const BASE_URL = `https://${DOMAIN}`;

/** Fingerprint exactly as the capture path computes it. */
export function fp(body = "", query = "", contentType = "", valuePaths?: string[]): string {
  return computeFingerprint(body, query, contentType, valuePaths).fingerprint;
}

export const FP_EMPTY_GET = fp();

export function variant(status: number, body: string | null | object, o: Partial<BundleVariant> = {}): BundleVariant {
  return {
    status,
    count: 1,
    duration_ms: 5,
    headers: { "content-type": "application/json" },
    body,
    ...o,
  };
}

export function sample(captureId: string, body: string, o: Partial<BundleSample> = {}): BundleSample {
  return {
    capture_id: captureId,
    captured_at: "2026-09-01T00:00:00Z",
    duration_ms: 5,
    headers: { "content-type": "application/json" },
    body,
    ...o,
  };
}

/** A variant as the server returns it for `?samples>1`. */
export function windowed(status: number, count: number, samples: BundleSample[]): BundleVariant {
  return { ...variant(status, samples[0]?.body ?? null, { count }), samples };
}

export function stub(fingerprint: string, variants: BundleVariant[], o: Partial<BundleStub> = {}): BundleStub {
  return { fingerprint, key_paths: [], field_rules: [], degraded: false, variants, ...o };
}

export function endpoint(
  method: string,
  pathTemplate: string,
  stubs: BundleStub[],
  o: Partial<BundleEndpoint> = {},
): BundleEndpoint {
  return {
    domain: DOMAIN,
    method,
    path_template: pathTemplate,
    is_dynamic: pathTemplate.includes("{"),
    fingerprint_value_paths: [],
    stubs,
    ...o,
  };
}

export function bundle(...endpoints: BundleEndpoint[]): Bundle {
  return { ok: true, version: 1, cursor: "1", generated_at: "2026-09-01T00:00:00Z", endpoints };
}

/** A bundle of one body-less GET per path, each serving `{ "path": ... }` JSON. */
export function simpleBundle(): Bundle {
  return bundle(
    endpoint("GET", "/users/{id}", [stub(FP_EMPTY_GET, [variant(200, '{"id": 42, "name": "Ada"}', { headers: { "content-type": "application/json", "x-served": "replay" } })])]),
    endpoint("GET", "/health", [stub(FP_EMPTY_GET, [variant(200, '{"ok": true}')])]),
    endpoint("POST", "/orders", [
      stub(fp('{"sku": "a"}', "", "application/json"), [variant(201, '{"order_id": 7}')], { key_paths: ["sku"], content_type: "application/json", query_names: [] }),
    ]),
  );
}

/** Temp directory removed by the returned cleanup. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stubsmith-replay-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
