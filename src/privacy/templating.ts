/**
 * URL path templating: curated template matching and the heuristic `{id}` fallback.
 * The ID rules are generated from the shared classifier spec (classifiers.generated.ts).
 * Port of stubsmith/privacy/templating.py.
 */
import { compareCodePoints } from "../internal/codepoint.js";
import { PY_END } from "../internal/pystr.js";
import { isIdSegment } from "./classifiers.generated.js";

// `$` is Python `$` (also matches before a trailing "\n"), see PY_END.
// Named wildcard segment such as {id}; `{}` is not a wildcard.
const WILDCARD_SEG_RE = new RegExp(`^\\{[^{}]+\\}${PY_END}`);

/** A curated path template with its split segments and literal-segment count precomputed once at load time. */
export interface CuratedTemplate {
  template: string;
  literalCount: number;
  /** Non-empty `/`-separated segments of `template`. */
  segments: readonly string[];
  /** Per segment: true when it is a `{name}` wildcard. */
  wildcards: readonly boolean[];
}

/**
 * Parse raw template strings and sort them for hot-path matching: more
 * literal segments first, then the template string ascending (code point order).
 */
export function loadCuratedTemplates(templates: readonly string[]): readonly CuratedTemplate[] {
  const curated: CuratedTemplate[] = [];
  for (const t of templates) {
    const segs = t.split("/").filter((s) => s !== "");
    const wildcards = segs.map((s) => WILDCARD_SEG_RE.test(s));
    const literalCount = wildcards.filter((w) => !w).length;
    curated.push({ template: t, literalCount, segments: segs, wildcards });
  }
  curated.sort((a, b) => b.literalCount - a.literalCount || compareCodePoints(a.template, b.template));
  return Object.freeze(curated);
}

/**
 * Templated form of `path`: first matching curated template (same number of
 * non-empty segments; each segment equal or a wildcard), else the heuristic
 * when `groupIds` is true (the project's "Group IDs in paths automatically"
 * setting), otherwise `path` as written.
 */
export function templatePath(path: string, curated: readonly CuratedTemplate[], groupIds = true): string {
  const pathSegs = path.split("/").filter((s) => s !== "");
  for (const ct of curated) {
    const tSegs = ct.segments;
    if (tSegs.length !== pathSegs.length) continue;
    if (tSegs.every((ts, i) => ct.wildcards[i] === true || ts === pathSegs[i])) return ct.template;
  }
  return groupIds ? heuristicTemplate(path) : path;
}

/** Replace ID-looking path segments with `{id}`. No percent-decoding. */
export function heuristicTemplate(path: string): string {
  return path
    .split("/")
    .map((p) => (p !== "" && isIdSegment(p) ? "{id}" : p))
    .join("/");
}
