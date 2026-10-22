/**
 * Translate a Python `re` pattern (str, Unicode semantics) into a JS RegExp.
 *
 * Mirrors stubsmith/privacy/masking.py:87-124 `compile_rules`, whose patterns
 * are compiled by Python `re.compile`. The result always uses the `u` flag
 * (needed for `\p{..}`), plus `g` (replace-all) and `i` when requested.
 * JS `m` and `s` flags are never emitted: `^ $ .` are rewritten into
 * lookarounds / classes so that only `\n` is a line terminator, as in Python.
 *
 * Inside a character class `\D` becomes `\P{Nd}`; `\W` and `\S` cannot be
 * expressed in a JS `u`-mode class, so the whole class is rewritten as an
 * alternation (`[\W x]` -> `(?:[ x]|[^W-set])`, negated `[^\W x]` ->
 * `(?:(?![ x])(?=[W-set])[\s\S])`).
 *
 * Known gaps (returned as `{ error }`, never papered over): `\N{name}`,
 * conditionals `(?(id)..)`, scoped or
 * mid-pattern inline flags, the `x`/`a`/`L` flags, possessive quantifiers,
 * atomic groups. Approximations: Python `\w` is rendered as
 * `[\p{L}\p{N}_]` (Python uses str.isalnum), `\s` as an explicit Unicode
 * whitespace set (Python str.isspace); case folding under `i` follows JS
 * (`iu`) rather than Python's `re` tables, except that i, I, İ and ı fold
 * together as in Python. One known difference remains under `i`: JS folds
 * U+0345 (a combining mark) with Greek iota before testing a class, so \w, \W,
 * \b and \B treat it as a word character, where Python's \w (a category) does
 * not. No JS construct can tell U+0345 from iota while `i` is on; it only
 * matters for text that contains U+0345 next to a word character; Python octal escapes `\0oo` and
 * `\U` are handled, but `\10`-style two-digit backreference vs octal rules
 * are passed through to JS.
 *
 * Known semantic differences (not errors):
 * - Lazy empty-match `re.sub` semantics differ: `a*?` on "a" gives `###` in
 *   Python but `#a#` in JS.
 * - Python rejects variable-width lookbehind and quantified `\b`; this port
 *   accepts both (conservative: it masks more, never less).
 */

const W = "\\p{L}\\p{N}_";
const SPACE = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD_B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
const NOT_WORD_B = `(?:(?<=[${W}])(?=[${W}])|(?<![${W}])(?![${W}]))`;
const JS_SYNTAX = "^$\\.*+?()[]{}|/";

class Unsupported extends Error {}

// Python's `re` folds these four together under IGNORECASE; JS `iu` folds only i with I.
const I_FOLD = ["i", "I", "\u0130", "\u0131"];
const I_FOLD_CLASS = "[iI\u0130\u0131]";

function translateBody(pattern: string, flagM: boolean, flagS: boolean, ignoreCase: boolean): string {
  let out = "";
  let i = 0;
  const n = pattern.length;
  // 0 none, 1 just emitted a quantifier, 2 just emitted a lazy `?` after one
  let quant = 0;
  let inClass = false;
  let classStart = false;

  // Class being built: index in `out` of its `[`, whether it is `[^`, and
  // which negated escapes (\W, \S) it contains (removed from the body).
  let classOpen = 0;
  let classNeg = false;
  let classW = false;
  let classS = false;

  const negatedInClass = (which: "W" | "S"): string => {
    // A range endpoint such as `a-\W` is an error in Python; reject it too.
    const bs = /\\*-$/.exec(out);
    const unescapedHyphen = bs !== null && (bs[0].length - 1) % 2 === 0;
    if (unescapedHyphen && out.length > classOpen + 1 + (classNeg ? 1 : 0) + 1) {
      throw new Unsupported(`bad character range with \\${which}`);
    }
    if (pattern[i] === "-" && pattern[i + 1] !== "]") {
      throw new Unsupported(`bad character range with \\${which}`);
    }
    if (which === "W") classW = true;
    else classS = true;
    return "";
  };

  // Under `i`, Python folds i, I, İ (U+0130) and ı (U+0131) together and JS `iu` does not. A class whose own
  // characters include any of the four gets all four, added inside the class: an alternation next to it would
  // make an ordinary [a-z]+ ambiguous, and backtrack exponentially. A trailing literal `-` is escaped first, so
  // the added characters cannot form a range with it. Runs before closeClass, on the class as written.
  const foldClass = (): void => {
    if (!ignoreCase) return;
    const start = classOpen + 1 + (classNeg ? 1 : 0);
    let content = out.slice(start, -1); // minus the closing `]`
    if (content === "") return;
    let probe: RegExp;
    try {
      probe = new RegExp(`^[${content}]$`, "iu");
    } catch {
      return; // the final RegExp construction reports it
    }
    if (!I_FOLD.some((ch) => probe.test(ch))) return;
    const trailing = /\\*-$/.exec(content);
    if (trailing && (trailing[0].length - 1) % 2 === 0) content = content.slice(0, -1) + "\\-";
    out = out.slice(0, start) + content + I_FOLD.join("") + "]";
  };

  const closeClass = (): void => {
    if (!classW && !classS) return;
    const inner = out.slice(classOpen + 1 + (classNeg ? 1 : 0), -1); // minus the closing `]`
    const sets: string[] = [];
    if (classW) sets.push(W);
    if (classS) sets.push(SPACE);
    let alt: string;
    if (classNeg) {
      // not (inner | non-W | non-S) = not inner, and in W, and in SPACE-set
      alt = "(?:" + (inner === "" ? "" : `(?![${inner}])`) + sets.map((x) => `(?=[${x}])`).join("") + "[\\s\\S])";
    } else {
      const alts = (inner === "" ? [] : [`[${inner}]`]).concat(sets.map((x) => `[^${x}]`));
      alt = "(?:" + alts.join("|") + ")";
    }
    out = out.slice(0, classOpen) + alt;
    classW = false;
    classS = false;
  };

  const escape = (): string => {
    const c = pattern[i + 1];
    if (c === undefined) throw new Unsupported("trailing backslash");
    i += 2;
    switch (c) {
      case "d": return "\\p{Nd}";
      case "D": return "\\P{Nd}";
      case "w": return inClass ? W : `[${W}]`;
      case "W":
        if (inClass) return negatedInClass("W");
        return `[^${W}]`;
      case "s": return inClass ? SPACE : `[${SPACE}]`;
      case "S":
        if (inClass) return negatedInClass("S");
        return `[^${SPACE}]`;
      case "b": return inClass ? "\\x08" : WORD_B;
      case "B":
        if (inClass) throw new Unsupported("\\B inside a character class");
        return NOT_WORD_B;
      case "A":
        if (inClass) throw new Unsupported("\\A inside a character class");
        return flagM ? "(?<![\\s\\S])" : "^";
      case "Z":
        if (inClass) throw new Unsupported("\\Z inside a character class");
        return "(?![\\s\\S])";
      case "a": return "\\x07";
      case "n": case "r": case "t": case "f": case "v": return "\\" + c;
      case "x": {
        const hex = pattern.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Unsupported("bad \\x escape");
        i += 2;
        if (ignoreCase && !inClass && I_FOLD.includes(String.fromCharCode(parseInt(hex, 16)))) return I_FOLD_CLASS;
        return "\\x" + hex;
      }
      case "u": {
        const hex = pattern.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Unsupported("bad \\u escape");
        i += 4;
        if (ignoreCase && !inClass && I_FOLD.includes(String.fromCharCode(parseInt(hex, 16)))) return I_FOLD_CLASS;
        return "\\u" + hex;
      }
      case "U": {
        const hex = pattern.slice(i, i + 8);
        if (!/^[0-9a-fA-F]{8}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) throw new Unsupported("bad \\U escape");
        i += 8;
        return "\\u{" + parseInt(hex, 16).toString(16) + "}";
      }
      case "N": throw new Unsupported("\\N{name} escapes");
      case "0": {
        const oct = /^[0-7]{0,2}/.exec(pattern.slice(i)) as RegExpExecArray;
        i += oct[0].length;
        return "\\x" + parseInt("0" + oct[0], 8).toString(16).padStart(2, "0");
      }
      default:
        if (c >= "1" && c <= "9") {
          if (inClass) throw new Unsupported("group reference inside a character class");
          return "\\" + c;
        }
        if (/[A-Za-z]/.test(c)) throw new Unsupported(`bad escape \\${c}`);
        if (inClass && c === "-") return "\\-";
        if (JS_SYNTAX.includes(c)) return "\\" + c;
        return c; // other punctuation / non-ASCII: literal (identity escapes are invalid under `u`)
    }
  };

  while (i < n) {
    const c = pattern[i] as string;
    if (inClass) {
      if (c === "]" && !classStart) {
        out += "]";
        foldClass();
        closeClass();
        inClass = false;
        i++;
      } else if (c === "\\") {
        out += escape();
        classStart = false;
      } else if (c === "]" || c === "[") {
        out += "\\" + c;
        i++;
        classStart = false;
      } else {
        out += c;
        i++;
        classStart = false;
      }
      continue;
    }

    const wasQuant = quant;
    quant = 0;
    switch (c) {
      case "\\":
        out += escape();
        break;
      case "[":
        inClass = true;
        classStart = true;
        classOpen = out.length;
        classNeg = false;
        out += "[";
        i++;
        if (pattern[i] === "^") {
          out += "^";
          classNeg = true;
          i++;
        }
        break;
      case "]":
        out += "\\]";
        i++;
        break;
      case ".":
        out += flagS ? "[\\s\\S]" : "[^\\n]";
        i++;
        break;
      case "^":
        out += flagM ? "(?<![^\\n])" : "^";
        i++;
        break;
      case "$":
        out += flagM ? "(?![^\\n])" : "(?=\\n?(?![\\s\\S]))";
        i++;
        break;
      case "*":
      case "+":
      case "?":
        if (wasQuant === 1 && c === "?") {
          out += "?";
          quant = 2;
        } else if (wasQuant === 1 && c === "+") {
          throw new Unsupported("possessive quantifier");
        } else {
          out += c;
          quant = 1;
        }
        i++;
        break;
      case "{": {
        const mm = /^\{(\d*)(?:(,)(\d*))?\}/.exec(pattern.slice(i));
        if (mm && (mm[1] !== "" || mm[2] !== undefined)) {
          const lo = mm[1] === "" ? "0" : (mm[1] as string);
          // Python raises OverflowError for a bound at or above MAXREPEAT (2**32 - 1).
          if ([lo, mm[3] ?? ""].some((n) => n !== "" && BigInt(n) >= 4294967295n)) {
            throw new Unsupported("the repetition number is too large");
          }
          out += "{" + lo + (mm[2] !== undefined ? "," + (mm[3] ?? "") : "") + "}";
          i += mm[0].length;
          quant = 1;
        } else {
          out += "\\{";
          i++;
        }
        break;
      }
      case "}":
        out += "\\}";
        i++;
        break;
      case "(": {
        if (pattern[i + 1] !== "?") {
          out += "(";
          i++;
          break;
        }
        const rest = pattern.slice(i);
        let mm: RegExpExecArray | null;
        if (rest.startsWith("(?:") || rest.startsWith("(?=") || rest.startsWith("(?!") ||
            rest.startsWith("(?<=") || rest.startsWith("(?<!")) {
          const len = rest.startsWith("(?<") ? 4 : 3;
          out += rest.slice(0, len);
          i += len;
        } else if ((mm = /^\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest))) {
          out += `(?<${mm[1]}>`;
          i += mm[0].length;
        } else if ((mm = /^\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/.exec(rest))) {
          out += `\\k<${mm[1]}>`;
          i += mm[0].length;
        } else if (rest.startsWith("(?#")) {
          const close = rest.indexOf(")");
          if (close === -1) throw new Unsupported("unterminated comment");
          i += close + 1;
          quant = wasQuant; // a comment is transparent
        } else if (rest.startsWith("(?>")) {
          throw new Unsupported("atomic group");
        } else if (rest.startsWith("(?(")) {
          throw new Unsupported("conditional group");
        } else {
          throw new Unsupported("inline flags other than a leading (?i) style group");
        }
        break;
      }
      default:
        out += ignoreCase && I_FOLD.includes(c) ? I_FOLD_CLASS : c;
        i++;
    }
  }
  if (inClass) throw new Unsupported("unterminated character class");
  return out;
}

/**
 * Translate a Python regex plus sync-payload flags (`"i"` or `""`; only `i`
 * is honoured, as in masking.py compile_rules) to a global JS RegExp.
 * A leading `(?aiLmsux)` group is honoured for i, m, s (u is a no-op for str
 * patterns); `x`, `a`, `L` give an error. Never throws.
 */
export function translatePythonRegex(pattern: string, flags: string): { regex: RegExp } | { error: string } {
  try {
    let ignoreCase = flags.includes("i");
    let flagM = false;
    let flagS = false;
    let body = pattern;
    const lead = /^\(\?([A-Za-z]+)\)/.exec(pattern);
    if (lead) {
      for (const f of lead[1] as string) {
        if (f === "i") ignoreCase = true;
        else if (f === "m") flagM = true;
        else if (f === "s") flagS = true;
        else if (f === "u") continue;
        else throw new Unsupported(`unsupported inline flag '${f}'`);
      }
      body = pattern.slice(lead[0].length);
    }
    const src = translateBody(body, flagM, flagS, ignoreCase);
    return { regex: new RegExp(src, "g" + (ignoreCase ? "i" : "") + "u") };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
