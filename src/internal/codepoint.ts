/**
 * Compare two strings by Unicode code point, the order Python `sorted()` /
 * `str.__lt__` uses (CPython Objects/unicodeobject.c `unicode_compare`, reached
 * via `PyUnicode_RichCompare`; the file is not vendored here so no line is
 * cited). JS default comparison is by UTF-16 code unit, which places astral
 * characters (surrogates D800-DFFF) before U+E000-U+FFFF.
 *
 * Both strings are walked one code point at a time with `codePointAt`. A
 * valid surrogate pair is one astral code point; a lone surrogate is its own
 * code point (0xD800..0xDFFF), as in a Python str, and is compared
 * numerically against whatever the other string holds at that position.
 */
export function compareCodePoints(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  let i = 0;
  let j = 0;
  while (i < la && j < lb) {
    const pa = a.codePointAt(i) as number;
    const pb = b.codePointAt(j) as number;
    if (pa !== pb) return pa < pb ? -1 : 1;
    i += pa > 0xffff ? 2 : 1;
    j += pb > 0xffff ? 2 : 1;
  }
  if (i < la) return 1;
  if (j < lb) return -1;
  return 0;
}

/**
 * Return a new array sorted by Unicode code point (Python `sorted(list)`).
 * The sort is stable. Does not mutate the input.
 */
export function sortCodePoints(arr: readonly string[]): string[] {
  return [...arr].sort(compareCodePoints);
}
