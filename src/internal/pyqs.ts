const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

const HEX = /^[0-9a-fA-F]{2}$/;

/**
 * Python `urllib.parse.unquote(s, encoding="utf-8", errors="replace")`
 * (Lib/urllib/parse.py:718; byte decoding in `unquote_to_bytes` :673):
 * each run of valid `%XX` escapes is decoded as UTF-8 on its own (invalid
 * bytes become U+FFFD); malformed escapes such as `%zz` stay literal.
 */
function unquote(s: string): string {
  if (!s.includes("%")) return s;
  let out = "";
  let run: number[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      out += decoder.decode(Uint8Array.from(run));
      run = [];
    }
  };
  let i = 0;
  while (i < s.length) {
    if (s[i] === "%" && HEX.test(s.slice(i + 1, i + 3))) {
      run.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      flush();
      out += s[i];
      i++;
    }
  }
  flush();
  return out;
}

/**
 * Replicates `urllib.parse.parse_qs(qs, keep_blank_values=True)`
 * (CPython Lib/urllib/parse.py:741 `parse_qs`, which calls `parse_qsl` :784): split on `&` only, drop empty
 * segments, split each on the first `=` (a segment without `=` has value
 * `""`), `+` becomes a space, then percent-decode as UTF-8 with replacement.
 * Keys keep first-occurrence order; repeated keys append values. A leading
 * `?` is NOT stripped (Python does not either).
 */
export function parseQs(qs: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const seg of qs.split("&")) {
    if (seg === "") continue;
    const eq = seg.indexOf("=");
    const rawName = eq === -1 ? seg : seg.slice(0, eq);
    const rawValue = eq === -1 ? "" : seg.slice(eq + 1);
    const name = unquote(rawName.replace(/\+/g, " "));
    const value = unquote(rawValue.replace(/\+/g, " "));
    const existing = out.get(name);
    if (existing) existing.push(value);
    else out.set(name, [value]);
  }
  return out;
}

/**
 * Python `parse_form`: `parseQs`, or `null` when the body is not a form. A
 * non-empty `&`-separated segment without `=` would otherwise become a key, so
 * free text labelled as a form would be sent as a field name.
 */
export function parseForm(body: string): Map<string, string[]> | null {
  if ((body || "").split("&").some((seg) => seg !== "" && !seg.includes("="))) return null;
  return parseQs(body);
}

const SAFE = /[A-Za-z0-9_.\-~]/;

/**
 * Python `urllib.parse.quote_plus(s)` (Lib/urllib/parse.py:956, via `quote`
 * :902): only `A-Za-z0-9_.-~` stay literal,
 * space becomes `+`, everything else is upper-case `%XX` of its UTF-8 bytes.
 * Lone surrogates encode as U+FFFD (Python would raise).
 */
function quotePlus(s: string): string {
  let out = "";
  for (const ch of s) {
    if (SAFE.test(ch)) out += ch;
    else if (ch === " ") out += "+";
    else {
      for (const b of encoder.encode(ch)) out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
    }
  }
  return out;
}

/**
 * Replicates `urllib.parse.urlencode(pairs, doseq=True)` for string keys and
 * string values (Lib/urllib/parse.py:1005 `urlencode`, quote_via=quote_plus). A Map
 * emits every value of each key in order; an array of pairs is emitted as
 * given. Pairs are joined with `&`.
 */
export function urlencodeDoseq(pairs: Map<string, string[]> | Array<[string, string]>): string {
  const parts: string[] = [];
  if (pairs instanceof Map) {
    for (const [k, vs] of pairs) {
      const qk = quotePlus(k);
      for (const v of vs) parts.push(qk + "=" + quotePlus(v));
    }
  } else {
    for (const [k, v] of pairs) parts.push(quotePlus(k) + "=" + quotePlus(v));
  }
  return parts.join("&");
}
