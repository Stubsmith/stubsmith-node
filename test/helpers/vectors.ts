import { readFileSync } from "node:fs";
import { jsonNumber, parseJson } from "../../src/internal/json.js";
import type { JsonValue } from "../../src/internal/json.js";

export interface VectorCase<I = Record<string, unknown>, E = Record<string, unknown>> {
  name: string;
  input: I;
  expected: E;
}

export interface VectorFile<I = Record<string, unknown>, E = Record<string, unknown>> {
  description: string;
  source: string;
  cases: Array<VectorCase<I, E>>;
}

/** Load `conformance/vectors/<file>` (plain `JSON.parse`; inputs that carry JSON source stay as text). */
export function loadVectors<I = Record<string, unknown>, E = Record<string, unknown>>(file: string): VectorFile<I, E> {
  const url = new URL(`../../conformance/vectors/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as VectorFile<I, E>;
}

/** Typed scalar of the conformance format: `{type: str|int|float|bool|none, value|text}`. */
export type TypedScalar =
  | { type: "str"; value: string }
  | { type: "int"; text: string }
  | { type: "float"; text: string }
  | { type: "bool"; value: boolean }
  | { type: "none" };

/** Python float repr text to the JSON token the Node number nodes carry. */
export function floatToken(text: string): string {
  if (text === "nan") return "NaN";
  if (text === "inf") return "Infinity";
  if (text === "-inf") return "-Infinity";
  return text;
}

export function fromTyped(t: TypedScalar): JsonValue {
  switch (t.type) {
    case "str": return t.value;
    case "bool": return t.value;
    case "none": return null;
    case "int": return jsonNumber(t.text);
    case "float": return jsonNumber(floatToken(t.text));
  }
}

/** Plain JSON data to parsed-JSON form (objects become Maps, numbers keep their token). */
export function toJsonValue(plain: unknown): JsonValue {
  return parseJson(JSON.stringify(plain));
}

/** Normalise to plain JSON (Maps to objects) for `toEqual`. */
export function plain<T = unknown>(v: unknown): T {
  return JSON.parse(
    JSON.stringify(v, (_k, x: unknown) => (x instanceof Map ? Object.fromEntries(x) : x)),
  ) as T;
}

/**
 * Expand the long-string forms of the shared vector files: `{"$repeat": "a", "times": n}` is that text
 * repeated, `{"$concat": [...]}` is the expansion of each part joined together.
 */
export function expandLong<T = unknown>(x: unknown): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 2 && "$repeat" in o && "times" in o) return (o["$repeat"] as string).repeat(o["times"] as number);
      if (keys.length === 1 && "$concat" in o) return (o["$concat"] as unknown[]).map((p) => walk(p) as string).join("");
      return Object.fromEntries(keys.map((k) => [k, walk(o[k])]));
    }
    return v;
  };
  return walk(x) as T;
}
