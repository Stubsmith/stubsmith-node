/**
 * In-memory rules cache: `(endpoint_id, fingerprint)` to compiled field rules,
 * plus path templates, project defaults, email domain, value config and the
 * sync cursor. Port of the state handling in stubsmith/privacy/rules_cache.py
 * (`_apply_sync_response`, the query interface). There is no legacy mode: a
 * backend without `/v1/sdk/sync` leaves the cache as it is and every lookup of
 * an unsynced fingerprint misses, so captures are fully masked.
 *
 * No HTTP and no timers: a poller calls {@link RulesCache.applySyncResponse}
 * for a 200 sync object.
 *
 * `endpoint_id` is `domain|METHOD|path_template`.
 */
import { isJsonNumber } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { pyStr } from "../internal/pyfloat.js";
import { dictGet, isDict, pyTruthy } from "../internal/pystr.js";
import { CompiledFieldRules, compileFieldRules } from "./fieldRules.js";
import { CompiledRules, compileRules } from "./masking.js";
import { loadCuratedTemplates } from "./templating.js";
import type { CuratedTemplate } from "./templating.js";

/** What {@link RulesCache.lookup} returns: `null` is a novel request. */
export type LookupResult = CompiledFieldRules | null;

/** Python `str(x)` for a truthy scalar JSON value (used for `cursor` and request-type parts). */
function strOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || isJsonNumber(v)) return pyStr(v as JsonValue);
  if (typeof v === "number") return String(v);
  throw new TypeError("unsupported value");
}

/** A string, `""` when absent/null/empty, `null` for any other type. */
function optString(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : null;
}

export class RulesCache {
  private rules = new Map<string, Map<string, CompiledFieldRules>>();
  private _cursor = "0";
  private _projectDefaults: CompiledRules | null = null;
  private _emailDomain = "stub.invalid";
  private templates: readonly CuratedTemplate[] = Object.freeze([]);
  // The "Group IDs in paths automatically" setting: on until a sync says otherwise.
  private _groupIdsInPaths = true;
  private _valueConfig = new Map<string, string[]>();
  private _firstSyncDone = false;

  /** Compiled rules for `(endpointId, fp)`, or `null` for an unknown fingerprint (a novel request). */
  lookup(endpointId: string, fp: string): LookupResult {
    return this.rules.get(endpointId)?.get(fp) ?? null;
  }

  /** Curated path templates, sorted for matching. A frozen array, replaced (never mutated) by each sync, so no per-call copy. */
  get pathTemplates(): readonly CuratedTemplate[] {
    return this.templates;
  }

  /** Synced project defaults, or `null` when none compiled to a rule. */
  get projectDefaults(): CompiledRules | null {
    return this._projectDefaults;
  }

  /** Email placeholder domain; `stub.invalid` until a sync supplies one. */
  get emailDomain(): string {
    return this._emailDomain;
  }

  /** Whether path segments that look like IDs become `{id}`; true until a sync sets `project_settings.group_ids_in_paths` to false. */
  get groupIdsInPaths(): boolean {
    return this._groupIdsInPaths;
  }

  /** `endpoint_id` to value-discrimination paths (snapshot). */
  get valueConfig(): Map<string, string[]> {
    return new Map([...this._valueConfig].map(([k, v]) => [k, [...v]]));
  }

  /** Value-discrimination paths for `endpointId` (empty when none). */
  getValuePaths(endpointId: string): string[] {
    return [...(this._valueConfig.get(endpointId) ?? [])];
  }

  /** Sync cursor, `"0"` initially. */
  get cursor(): string {
    return this._cursor;
  }

  /** True once a sync has completed; never cleared. */
  get firstSyncDone(): boolean {
    return this._firstSyncDone;
  }

  /**
   * Merge a successful `GET /v1/sdk/sync` body (parsed JSON; `Map` or plain
   * object). Rules are additive per `(endpoint_id, fingerprint)`; an empty
   * fingerprint is skipped. The cursor moves only when it is not `"0"`.
   * `path_templates` is a full replacement (absent clears it);
   * `project_defaults` is stored only when it compiles to at least one rule,
   * `email_placeholder_domain` overrides only when a non-empty string;
   * `request_type_value_config` is a full replacement when an object;
   * `project_settings.group_ids_in_paths` is stored only when a boolean. A
   * non-object body is ignored; malformed rule entries are
   * skipped. All inputs are processed before any state changes.
   */
  applySyncResponse(body: unknown): void {
    // Diverges from Python: a body that is not an object (null, array, string, number) is ignored
    // outright, so a garbage 200 cannot mark the first sync done.
    if (!isDict(body)) return;
    const cursorRaw = dictGet(body, "cursor");
    const newCursor = pyTruthy(cursorRaw) ? safeStr(cursorRaw) : "0";
    const rulesRaw = dictGet(body, "rules");
    const rulesList = pyTruthy(rulesRaw) && Array.isArray(rulesRaw) ? rulesRaw : [];
    const templatesRaw = dictGet(body, "path_templates");
    const templatesList = pyTruthy(templatesRaw) && Array.isArray(templatesRaw) ? templatesRaw : [];

    const additions: Array<[string, string, CompiledFieldRules]> = [];
    for (const rule of rulesList as unknown[]) {
      if (!isDict(rule)) continue;
      // Diverges from Python: a rule whose request_type parts or fingerprint are not strings is skipped
      // (Python would build strings such as "[1]" from them, and a numeric fingerprint could never match the
      // string fingerprints the pipeline computes). One bad entry must not abort the whole sync.
      const rtRaw = dictGet(rule, "request_type");
      const rt = pyTruthy(rtRaw) ? rtRaw : undefined;
      if (rt !== undefined && !isDict(rt)) continue;
      const domain = optString(dictGet(rt, "domain"));
      const methodRaw = optString(dictGet(rt, "method"));
      const pathTemplate = optString(dictGet(rt, "path_template"));
      const fp = optString(dictGet(rule, "fingerprint"));
      if (domain === null || methodRaw === null || pathTemplate === null || fp === null || !fp) continue;
      let compiledRules: CompiledFieldRules;
      try {
        compiledRules = compileFieldRules(dictGet(rule, "field_rules"));
      } catch {
        // Diverges from Python: a malformed field_rules entry skips this rule (it stays novel, so it
        // is masked fail-closed) instead of aborting the sync and wedging the cursor.
        continue;
      }
      additions.push([`${domain}|${methodRaw.toUpperCase()}|${pathTemplate}`, fp, compiledRules]);
    }

    const curated = loadCuratedTemplates(templatesList.filter((t): t is string => typeof t === "string"));

    let projectDefaults: CompiledRules | null = null;
    let newEmailDomain: string | null = null;
    const pd = dictGet(body, "project_defaults");
    // Present but not an object, or failing to compile: fail closed with an unusable rule set (every kept string is
    // masked until a sync delivers valid rules) instead of aborting the sync or dropping every project mask, as Python
    // does. Absent or null means none.
    if (pd !== undefined && pd !== null && !isDict(pd)) {
      console.warn("stubsmith: synced project_defaults is not an object; every kept string will be masked until a sync delivers valid rules");
      projectDefaults = new CompiledRules(new Set(), [], true);
    }
    if (isDict(pd)) {
      try {
        const compiled = compileRules(dictGet(pd, "field_masks"), dictGet(pd, "regex_masks"));
        // Only store when there is at least one rule, counting a pattern that cannot be used (every kept string is then masked).
        if (compiled.fieldMasks.size > 0 || compiled.regexMasks.length > 0 || compiled.unusable) projectDefaults = compiled;
      } catch (e) {
        console.warn(`stubsmith: synced project_defaults cannot be used (${String(e)}); every kept string will be masked until a sync delivers valid rules`);
        projectDefaults = new CompiledRules(new Set(), [], true);
      }
      const rawDomain = dictGet(pd, "email_placeholder_domain");
      if (typeof rawDomain === "string" && rawDomain) newEmailDomain = rawDomain;
    }

    // project_settings: a missing key or a non-boolean value leaves the setting as it is.
    let newGroupIds: boolean | null = null;
    const ps = dictGet(body, "project_settings");
    if (isDict(ps)) {
      const g = dictGet(ps, "group_ids_in_paths");
      if (typeof g === "boolean") newGroupIds = g;
    }

    let newValueConfig: Map<string, string[]> | null = null;
    const vc = dictGet(body, "request_type_value_config");
    if (isDict(vc)) {
      newValueConfig = new Map();
      const entries: Iterable<[string, unknown]> = vc instanceof Map ? vc : Object.entries(vc);
      for (const [eid, paths] of entries) {
        if (!Array.isArray(paths)) continue;
        newValueConfig.set(eid, paths.filter((p): p is string => typeof p === "string"));
      }
    }

    if (additions.length > 0) {
      const next = new Map<string, Map<string, CompiledFieldRules>>();
      for (const [eid, byFp] of this.rules) next.set(eid, new Map(byFp));
      for (const [eid, fp, compiled] of additions) {
        let byFp = next.get(eid);
        if (byFp === undefined) next.set(eid, (byFp = new Map()));
        byFp.set(fp, compiled);
      }
      this.rules = next;
    }
    if (newCursor !== "0") this._cursor = newCursor;
    this.templates = curated;
    if (projectDefaults !== null) this._projectDefaults = projectDefaults;
    if (newEmailDomain !== null) this._emailDomain = newEmailDomain;
    if (newGroupIds !== null) this._groupIdsInPaths = newGroupIds;
    if (newValueConfig !== null) this._valueConfig = newValueConfig;
    this._firstSyncDone = true;
  }
}

/** `str()` of a truthy cursor; containers (Python would print their repr) are not a real cursor and map to `"0"`. */
function safeStr(v: unknown): string {
  try {
    return strOf(v);
  } catch {
    return "0";
  }
}
