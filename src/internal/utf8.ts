const encoder = new TextEncoder();

/**
 * Encode a string as UTF-8. Mirrors Python `str.encode("utf-8")`, except that
 * lone surrogates become U+FFFD (EF BF BD) instead of raising.
 */
export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/**
 * Decode UTF-8 bytes. With `fatal: true` invalid input throws a `TypeError`
 * (Python `bytes.decode("utf-8")`); otherwise invalid sequences become U+FFFD
 * (Python `errors="replace"`). A leading BOM is preserved, as in Python.
 */
export function utf8Decode(bytes: Uint8Array, opts: { fatal?: boolean } = {}): string {
  return new TextDecoder("utf-8", { fatal: opts.fatal === true, ignoreBOM: true }).decode(bytes);
}

/**
 * First `n` bytes of the UTF-8 encoding of `s`. This is a raw byte cut that
 * may split a multi-byte character, exactly like Python
 * `val.encode("utf-8")[:64]` (stubsmith/privacy/placeholders.py:152) used for
 * the BLAKE2b salt key.
 */
export function truncateUtf8Bytes(s: string, n: number): Uint8Array {
  return utf8Encode(s).subarray(0, Math.max(0, n));
}
