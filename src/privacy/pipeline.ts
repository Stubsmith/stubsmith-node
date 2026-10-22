/**
 * PrivacyPipeline: edge orchestrator for one captured exchange.
 * Port of stubsmith/privacy/pipeline.py.
 *
 * Steps: parse URL; case-insensitive content-type lookup; `image/*` bodies
 * replaced by a base64 1x1 placeholder before fingerprinting; path template
 * and endpoint id; value paths; fingerprints, key paths, value types, header
 * and query names; cache lookup; masking (a masking error degrades to
 * `maskAll` with `novel: true`); placeholder bodies restored; payload
 * assembly. `process` never throws and returns `null` on a catastrophic error
 * so the caller drops the capture rather than sending raw data.
 */
import { sortCodePoints } from "../internal/codepoint.js";
import { truncateUtf8Bytes } from "../internal/utf8.js";
import { pyUrlParse } from "../internal/pyurl.js";
import { VERSION } from "../_version.js";
import { isImage, placeholderFor } from "./binary.js";
import { CompiledFieldRules, applyFieldRules, applyRespFieldRules } from "./fieldRules.js";
import {
  computeFingerprint,
  computeRespFingerprint,
  extractKeypaths,
  extractValueTypes,
  uniqueQueryNames,
} from "./fingerprint.js";
import { SPEC_VERSION } from "./classifiers.generated.js";
import { maskAll, toHeaderMap } from "./masking.js";
import type { HeaderInput } from "./masking.js";
import type { RulesCache } from "./rulesCache.js";
import { templatePath } from "./templating.js";

/** One captured request/response pair. Bodies are text; headers are name to value. */
export interface PipelineInput {
  method: string;
  /** Full outbound URL including scheme, host, path and query. */
  url: string;
  reqHeaders: HeaderInput;
  reqBody: string;
  status: number;
  respHeaders: HeaderInput;
  respBody: string;
}

/** Wire payload minus `source` and `duration` (the client adds those). */
export interface Payload {
  sdk_version: string;
  classifier_spec_version: number;
  sdk_masked: true;
  sdk_rule_version: string;
  domain: string;
  path_template: string;
  path: string;
  method: string;
  status: number;
  req_fingerprint: string;
  resp_fingerprint: string;
  key_paths: string[];
  resp_key_paths: string[];
  req_header_names: string[];
  resp_header_names: string[];
  query_names: string[];
  headers: Record<string, string>;
  req_body: string;
  resp_headers: Record<string, string>;
  resp_body: string;
  novel: boolean;
  req_body_encoding?: "base64";
  resp_body_encoding?: "base64";
  fingerprint_value_paths?: string[];
  req_value_types?: Record<string, string>;
  resp_value_types?: Record<string, string>;
  /**
   * Raw path (no query) of a capture templated before the first rules sync, so the sender can template
   * it again once "Group IDs in paths automatically" is known. Private: held in memory, never sent.
   */
  _raw_path?: string;
}

export interface PipelineOptions {
  /** Overrides `sdk_version` in every payload; defaults to the package version. */
  sdkVersion?: string;
  /**
   * Placeholder salt. When omitted, `STUBSMITH_MASK_SALT` is read at call time
   * (the conformance behaviour); an empty string means no salt.
   */
  salt?: string;
}

/** Map to a plain object; own-property definition keeps `__proto__` and integer-like keys as data. */
function toRecord(m: ReadonlyMap<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of m) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}

/** Case-insensitive header lookup, first match in insertion order. */
function getHeader(headers: ReadonlyMap<string, string>, name: string, dflt = ""): string {
  const want = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === want) return String(v);
  return dflt;
}

/** Replace an image body with the base64 1x1 placeholder; `encoding` is `"base64"` when replaced. */
function maybeReplaceImage(body: string, contentType: string): { body: string; encoding: "base64" | null } {
  if (isImage(contentType)) {
    return { body: Buffer.from(placeholderFor(contentType).bytes).toString("base64"), encoding: "base64" };
  }
  return { body, encoding: null };
}

export class PrivacyPipeline {
  private readonly cache: RulesCache;
  private readonly sdkVersion: string;
  /** `undefined` defers to the environment; `null` is an explicit "no salt". */
  private readonly salt: Uint8Array | null | undefined;

  constructor(rulesCache: RulesCache, opts: PipelineOptions = {}) {
    this.cache = rulesCache;
    this.sdkVersion = opts.sdkVersion ?? VERSION;
    this.salt = opts.salt === undefined ? undefined : opts.salt === "" ? null : truncateUtf8Bytes(opts.salt, 64);
  }

  /** Privacy-processed payload, or `null` on catastrophic failure (drop the capture). Never throws. */
  process(input: PipelineInput): Payload | null {
    try {
      return this.processInner(input);
    } catch {
      return null;
    }
  }

  private processInner(input: PipelineInput): Payload {
    const methodUpper = input.method.toUpperCase();
    // Read before templating: a sync landing mid-capture then leaves the marker set, which only costs a recompute.
    const syncedAtCapture = this.cache.firstSyncDone;

    // 1. Parse URL
    const parsed = pyUrlParse(input.url);
    // host[:port] only: userinfo (`user:password@`) never leaves the SDK.
    const netloc = parsed.netloc || "";
    const domain = netloc.slice(netloc.lastIndexOf("@") + 1);
    const path = parsed.path || "/";
    const queryString = parsed.query || "";

    // 2. Content types
    const reqHeaders = toHeaderMap(input.reqHeaders);
    const respHeaders = toHeaderMap(input.respHeaders);
    const reqCt = getHeader(reqHeaders, "content-type", "");
    const respCt = getHeader(respHeaders, "content-type", "");

    // 3. Image body replacement (before fingerprinting)
    const reqImg = maybeReplaceImage(input.reqBody, reqCt);
    const respImg = maybeReplaceImage(input.respBody, respCt);
    const reqBody = reqImg.body;
    const respBody = respImg.body;
    const reqBodyEncoding = reqImg.encoding;
    const respBodyEncoding = respImg.encoding;

    // 4. Path template
    const pathTemplate = templatePath(path, this.cache.pathTemplates, this.cache.groupIdsInPaths);
    const endpointId = `${domain}|${methodUpper}|${pathTemplate}`;

    // 5. Value-discriminator paths (per endpoint, from sync)
    const valuePathsList = this.cache.getValuePaths(endpointId);
    const valuePaths = valuePathsList.length > 0 ? valuePathsList : null;

    // 6. Fingerprints, key paths, value types, names (post-image bodies)
    const reqFp = computeFingerprint(reqBody, queryString, reqCt, valuePaths).fingerprint;
    const respFp = computeRespFingerprint(input.status, respBody, queryString, respCt).fingerprint;
    const keyPaths = extractKeypaths(reqBody, reqCt);
    const respKeyPaths = extractKeypaths(respBody, respCt);
    // Type labels are format names, never values. classifyScalar reads each value to pick its label, and the label
    // is sent; no masking decision reads it. What is masked is decided by the customer's rules alone.
    const reqValueTypes = extractValueTypes(reqBody, reqCt);
    const respValueTypes = extractValueTypes(respBody, respCt);
    const reqHeaderNames = sortCodePoints([...reqHeaders.keys()].map((k) => k.toLowerCase()));
    const respHeaderNames = sortCodePoints([...respHeaders.keys()].map((k) => k.toLowerCase()));
    const queryNames = uniqueQueryNames(queryString);

    // 7. Lookup
    const lookup = this.cache.lookup(endpointId, reqFp);

    // 8. Masking, degrading to maskAll on any error
    let mb: string;
    let mh: Map<string, string>;
    let mq: string;
    let respMb: string;
    let respMh: Map<string, string>;
    let novel: boolean;
    try {
      [mb, mh, mq, respMb, respMh, novel] = this.applyMasking(
        lookup, reqBody, reqHeaders, queryString, reqCt, respBody, respHeaders, respCt, input.status,
      );
    } catch {
      novel = true;
      // A failure here is catastrophic: it propagates and process() returns null.
      [mb, mh, mq] = maskAll(reqBody, reqHeaders, queryString, reqCt);
      [respMb, respMh] = maskAll(respBody, respHeaders, "", respCt);
    }

    // 9. Image placeholder bodies must not be masked: restore the base64 placeholder.
    if (reqBodyEncoding) mb = reqBody;
    if (respBodyEncoding) respMb = respBody;

    // 11. Assemble payload (bodies are never truncated)
    const payload: Payload = {
      sdk_version: this.sdkVersion,
      // The classifier spec the value-type labels below come from.
      classifier_spec_version: SPEC_VERSION,
      sdk_masked: true,
      sdk_rule_version: this.cache.cursor,
      domain,
      path_template: pathTemplate,
      path: pathTemplate + (mq ? `?${mq}` : ""),
      method: methodUpper,
      status: input.status,
      req_fingerprint: reqFp,
      resp_fingerprint: respFp,
      key_paths: keyPaths,
      resp_key_paths: respKeyPaths,
      req_header_names: reqHeaderNames,
      resp_header_names: respHeaderNames,
      query_names: queryNames,
      headers: toRecord(mh),
      req_body: mb,
      resp_headers: toRecord(respMh),
      resp_body: respMb,
      novel,
    };
    // The grouping setting is unknown until the first sync, so the template above assumed it on. Keep the raw
    // path for the sender to template again once the setting is known.
    if (!syncedAtCapture) payload._raw_path = path;
    if (reqBodyEncoding) payload.req_body_encoding = reqBodyEncoding;
    if (respBodyEncoding) payload.resp_body_encoding = respBodyEncoding;
    // Path names only, never values.
    if (valuePaths) payload.fingerprint_value_paths = valuePaths;
    if (reqValueTypes.size > 0) payload.req_value_types = toRecord(reqValueTypes);
    if (respValueTypes.size > 0) payload.resp_value_types = toRecord(respValueTypes);
    return payload;
  }

  /** Python `_apply_masking`: returns `[mb, mh, mq, respMb, respMh, novel]`. */
  private applyMasking(
    lookup: CompiledFieldRules | null,
    reqBody: string,
    reqHeaders: HeaderInput,
    queryString: string,
    reqCt: string,
    respBody: string,
    respHeaders: HeaderInput,
    respCt: string,
    respStatus: number,
  ): [string, Map<string, string>, string, string, Map<string, string>, boolean] {
    if (lookup instanceof CompiledFieldRules) {
      // Modern mode: per-fingerprint field rules plus the synced project defaults, if any.
      const opts = {
        extraRules: this.cache.projectDefaults,
        emailDomain: this.cache.emailDomain,
        salt: this.salt,
      };
      const [mb, mh, mq] = applyFieldRules(reqBody, reqHeaders, queryString, reqCt, lookup, opts);
      const [respMb, respMh] = applyRespFieldRules(respBody, respHeaders, respCt, lookup, respStatus, opts);
      return [mb, mh, mq, respMb, respMh, false];
    }
    // Unknown fingerprint: fail closed
    const [mb, mh, mq] = maskAll(reqBody, reqHeaders, queryString, reqCt);
    const [respMb, respMh] = maskAll(respBody, respHeaders, "", respCt);
    return [mb, mh, mq, respMb, respMh, true];
  }
}
