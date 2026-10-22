/**
 * BLAKE2b (RFC 7693) with variable digest length and optional key, on
 * 32-bit word pairs (no BigInt). Mirrors Python `hashlib.blake2b(data,
 * digest_size=n, key=k)` as used in stubsmith/privacy/fingerprint.py:271-285
 * (unkeyed, 8 bytes) and placeholders.py:198-204 (keyed, 16 bytes).
 *
 * Layout: a 64-bit word i lives in two adjacent Uint32 slots, low at 2i and
 * high at 2i+1.
 */

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
].map((r) => Uint8Array.from(r));

const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** v[a] += v[b] (64-bit). */
function add(a: number, b: number): void {
  const lo = (v[a] as number) + (v[b] as number);
  v[a] = lo >>> 0;
  v[a + 1] = ((v[a + 1] as number) + (v[b + 1] as number) + (lo > 0xffffffff ? 1 : 0)) >>> 0;
}

/** v[a] += m[b] (64-bit). */
function addM(a: number, b: number): void {
  const lo = (v[a] as number) + (m[b] as number);
  v[a] = lo >>> 0;
  v[a + 1] = ((v[a + 1] as number) + (m[b + 1] as number) + (lo > 0xffffffff ? 1 : 0)) >>> 0;
}

function g(a: number, b: number, c: number, d: number, x: number, y: number): void {
  let lo: number;
  let hi: number;
  add(a, b);
  addM(a, x);
  // d = rotr32(d ^ a): xor then swap halves
  lo = (v[d] as number) ^ (v[a] as number);
  hi = (v[d + 1] as number) ^ (v[a + 1] as number);
  v[d] = hi;
  v[d + 1] = lo;
  add(c, d);
  // b = rotr24(b ^ c)
  lo = (v[b] as number) ^ (v[c] as number);
  hi = (v[b + 1] as number) ^ (v[c + 1] as number);
  v[b] = ((lo >>> 24) | (hi << 8)) >>> 0;
  v[b + 1] = ((hi >>> 24) | (lo << 8)) >>> 0;
  add(a, b);
  addM(a, y);
  // d = rotr16(d ^ a)
  lo = (v[d] as number) ^ (v[a] as number);
  hi = (v[d + 1] as number) ^ (v[a + 1] as number);
  v[d] = ((lo >>> 16) | (hi << 16)) >>> 0;
  v[d + 1] = ((hi >>> 16) | (lo << 16)) >>> 0;
  add(c, d);
  // b = rotr63(b ^ c) = rotl1
  lo = (v[b] as number) ^ (v[c] as number);
  hi = (v[b + 1] as number) ^ (v[c + 1] as number);
  v[b] = ((lo << 1) | (hi >>> 31)) >>> 0;
  v[b + 1] = ((hi << 1) | (lo >>> 31)) >>> 0;
}

function compress(h: Uint32Array, block: Uint8Array, off: number, t: number, last: boolean): void {
  for (let i = 0; i < 32; i++) {
    const o = off + i * 4;
    m[i] =
      ((block[o] as number) |
        ((block[o + 1] as number) << 8) |
        ((block[o + 2] as number) << 16) |
        ((block[o + 3] as number) << 24)) >>> 0;
  }
  for (let i = 0; i < 16; i++) {
    v[i] = h[i] as number;
    v[16 + i] = IV[i] as number;
  }
  v[24] = ((v[24] as number) ^ (t >>> 0)) >>> 0;
  v[25] = ((v[25] as number) ^ Math.floor(t / 0x100000000)) >>> 0;
  if (last) {
    v[28] = ~(v[28] as number) >>> 0;
    v[29] = ~(v[29] as number) >>> 0;
  }
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r] as Uint8Array;
    g(0, 8, 16, 24, 2 * (s[0] as number), 2 * (s[1] as number));
    g(2, 10, 18, 26, 2 * (s[2] as number), 2 * (s[3] as number));
    g(4, 12, 20, 28, 2 * (s[4] as number), 2 * (s[5] as number));
    g(6, 14, 22, 30, 2 * (s[6] as number), 2 * (s[7] as number));
    g(0, 10, 20, 30, 2 * (s[8] as number), 2 * (s[9] as number));
    g(2, 12, 22, 24, 2 * (s[10] as number), 2 * (s[11] as number));
    g(4, 14, 16, 26, 2 * (s[12] as number), 2 * (s[13] as number));
    g(6, 8, 18, 28, 2 * (s[14] as number), 2 * (s[15] as number));
  }
  for (let i = 0; i < 16; i++) {
    h[i] = ((h[i] as number) ^ (v[i] as number) ^ (v[i + 16] as number)) >>> 0;
  }
}

/**
 * BLAKE2b digest of `data`. `digestLength` must be an integer in 1..64 and
 * `key` (optional) at most 64 bytes, else `RangeError` (Python raises
 * `ValueError`). An empty key behaves as no key, as in Python.
 */
export function blake2b(data: Uint8Array, opts: { digestLength: number; key?: Uint8Array }): Uint8Array {
  const { digestLength } = opts;
  const key = opts.key ?? new Uint8Array(0);
  if (!Number.isInteger(digestLength) || digestLength < 1 || digestLength > 64) {
    throw new RangeError("blake2b: digestLength must be an integer in 1..64");
  }
  if (key.length > 64) throw new RangeError("blake2b: key must be at most 64 bytes");

  const h = new Uint32Array(IV);
  h[0] = ((h[0] as number) ^ 0x01010000 ^ (key.length << 8) ^ digestLength) >>> 0;

  // A keyed message is the key padded to one full block followed by the data.
  // The key block is compressed first (final only when there is no data) and
  // the data is then streamed in place, so the input is never copied.
  let done = false;
  let base = 0;
  if (key.length > 0) {
    const keyBlock = new Uint8Array(128);
    keyBlock.set(key, 0);
    done = data.length === 0;
    compress(h, keyBlock, 0, 128, done);
    base = 128;
  }

  if (!done) {
    const len = data.length;
    let off = 0;
    while (len - off > 128) {
      compress(h, data, off, base + off + 128, false);
      off += 128;
    }
    // Final block: zero padded (also covers empty input and an exact 128 tail).
    const tail = new Uint8Array(128);
    tail.set(data.subarray(off), 0);
    compress(h, tail, 0, base + len, true);
  }

  const out = new Uint8Array(digestLength);
  for (let i = 0; i < digestLength; i++) {
    out[i] = ((h[i >> 2] as number) >>> ((i & 3) * 8)) & 0xff;
  }
  return out;
}

/** Lower-case hex of {@link blake2b}; Python `hashlib.blake2b(...).hexdigest()`. */
export function blake2bHex(data: Uint8Array, opts: { digestLength: number; key?: Uint8Array }): string {
  let s = "";
  for (const b of blake2b(data, opts)) s += (b < 16 ? "0" : "") + b.toString(16);
  return s;
}
