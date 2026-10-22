import { describe, expect, it } from "vitest";
import { blake2b, blake2bHex } from "../../src/internal/blake2b.js";
import { utf8Encode } from "../../src/internal/utf8.js";

// Expectations computed with Python hashlib.blake2b(data, digest_size=dl[, key=key]).hexdigest()
// data(n) = bytes((i*7+3)%256 for i in range(n)); key = bytes(range(1, 33))
function pat(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256);
}
const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const key64 = Uint8Array.from({ length: 64 }, (_, i) => i);

const VECTORS: Array<[number, number, boolean, string]> = [
  [0, 8, false, "e4a6a0577479b2b4"],
  [0, 8, true, "5d0771eae319035f"],
  [0, 16, false, "cae66941d9efbd404e4d88758ea67670"],
  [0, 16, true, "e2b54039ff142696133962440acfb945"],
  [0, 32, false, "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"],
  [0, 32, true, "6689399b55d2c998473a55fa741f5c0bd91c49e7d15cc211482a37d75a9d95a0"],
  [0, 64, false, "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"],
  [0, 64, true, "da6b37732835fce46fe6359537992d69c70020d72f6a076891aa102567dd36f8b6f4e4cf7bd8dc4b64a5fa232c7841bb7a96d68eaa288b4ebbd1f0940693cd62"],
  [1, 8, false, "c2fb54d88374033e"],
  [1, 8, true, "dcd89299486d9704"],
  [1, 16, false, "71b186b851e866e71be237342976049a"],
  [1, 16, true, "5e1581e3a4062d136aa7dec2e9f5d7a7"],
  [1, 32, false, "e88bd757ad5b9bedf372d8d3f0cf6c962a469db61a265f6418e1ffed86da29ec"],
  [1, 32, true, "8d2e157e494739fa12534dba051ba97be105b144ec7688ccd776369b8871c088"],
  [1, 64, false, "4fe4da61bcc756071b226843361d74944c72245d23e8245ea678c13fdcd7fe2ae529cf999ad99cc24f7a73416a18ba53e76c0afef83b16a568b12fbfc1a2674d"],
  [1, 64, true, "567e75a3573a7a1bbb51c56f0cc409dd2c2f300623d7aa2ee0f70aea366bd66240ef5294c92121ad3d7758d665b31f74162c68bf1ae6124a4b47b54b3b755267"],
  [127, 8, false, "5c7a95645fba062c"],
  [127, 8, true, "a2f7780a3eedf89d"],
  [127, 16, false, "e00ab0ead4d729de8fbe7745d642e416"],
  [127, 16, true, "43e47aad328a49e2d28769ccf98f2f12"],
  [127, 32, false, "c9ae3859964b35f04c54b36d33cf299d7290ee621005d28e51598a943560aaaa"],
  [127, 32, true, "be1f9b3363b7211f5300f007a9387f7e3fce0537390fa6b5c5f863e8331a29e5"],
  [127, 64, false, "71546bbf9110ad184cc60f2eb120fcfd9b4dbbca7a7f1270045b8a23a6a4f4330f65c1f030dd2f5fabc6c57617242c37cf427bd90407fac5b9deffd3ae888c39"],
  [127, 64, true, "b098ab4277e0ee33551562c78dc95816a3f90527a30e608a9e551e5ed236b98dd6220280065cff7e1ba6ea6fcb3781b5be27916cd19faf69540d22aa90d2f576"],
  [128, 8, false, "5a0875a570ceb2ae"],
  [128, 8, true, "22ac2731fbc99207"],
  [128, 16, false, "8e0cf9bb1b36fa6c42aa6490f719b575"],
  [128, 16, true, "345d8e5e1b8223533fd7afc6e0cbb70f"],
  [128, 32, false, "f0501d06597880592bc49234eef100ec1ff349058d0e9d9b753504e24af86dd6"],
  [128, 32, true, "d2e59685d0a3aa2ad41968c5aae207e2575a30effa42deb85bc70e7190fe0e55"],
  [128, 64, false, "2d9e329f42afa3601d646692b81c13e87fcaff5bf15972e9813d7373cb6d181f9599f4d513d4af4fd6ebd37497aceb29aba5ee23ed764d8510b552bd088814fb"],
  [128, 64, true, "180350a2fa832fea1eea84a5d16668bfa07872dbaedbd081d77d1d96f62317508168714cd41f66b68fff47556c424adf8b74479395ca0df96b849888c8d6610a"],
  [129, 8, false, "79f7ec8e27e1f993"],
  [129, 8, true, "d8d02aa9975cb513"],
  [129, 16, false, "6cefde50e4008690e61cf8225d101256"],
  [129, 16, true, "8329fa73198a77eb56272c5524459880"],
  [129, 32, false, "a34a4e1e03c541dfbf3099c4b6c143c022ced65c28bd7e8a10e0a098461aecf0"],
  [129, 32, true, "83678cfe55871c872c41adcf6cde7403fa2be0cece7f0ea41ce80aba47c4fb1b"],
  [129, 64, false, "47889df9eb4d717afc5019df5c6a83df00a0b8677395e078cd5778ace0f338a618e68b7d9afb065d9e6a01ccd31d109447e7fae771c3ee3e105709194122ba2b"],
  [129, 64, true, "7ade01d7ae0bb243afb22e736ad69238c5a7809a1faf841b41d085a637429dc1320c3644defa0202aa5f06568a7571d4aa50415def749b7cf6a86623aa104ec8"],
  [255, 8, false, "0382ae4bfbfb3aa2"],
  [255, 8, true, "05ed0f2bc30aabc6"],
  [255, 16, false, "b1bce9f0dc0bec101cd5e09b7961937c"],
  [255, 16, true, "78127fd875bb3c0f5cd6935d5812c3a4"],
  [255, 32, false, "f2d64a40e9412a3414161ff6250075225418fd7c271c1123e162e1bca0de9f93"],
  [255, 32, true, "ceeedd7c221fc41b0854100bc5b8e2864c4ae8432fdc6ea04df59deaff0ed824"],
  [255, 64, false, "1a5199ac66a00e8a87ad1c7fbad30b33137dd8312bf6d98602dacf8f40ea2cb623a7fbc63e5a6bfa434d337ae7da5ca1a52502a215a3fe0297a151be85d88789"],
  [255, 64, true, "fa24276d53aff309adcd6d8bb044a1865ba69112fb954fdab9658dba24e92070e36cba35465928d2dde20b1297d3f81cef5778eba5eba916de7d4298e35eecea"],
  [256, 8, false, "27cc63362e6b95a6"],
  [256, 8, true, "ff252f64be7ad529"],
  [256, 16, false, "ac60b0f8b3227af67328401630cd4dfa"],
  [256, 16, true, "ebda891388872c3f40b6800374ad977d"],
  [256, 32, false, "d93ebb9c802f5630ab22516fd82b6c21bc8bd551d531349b715f046ed11ed871"],
  [256, 32, true, "24dbd82086d8cb5cefd1f268ba03d94ccccd9cb95330cfec37917e8d84777fdc"],
  [256, 64, false, "91019c558584980249ca43eceed27e19f1c3c24161b93eed1eee2a6a774f60bf8a81b43750870bee1698feac9c5336ae4d5c842e7ead159bf3916387e8ded9ae"],
  [256, 64, true, "f3d949086564887927b2096752b6942e9d4d74920c733d93ee0b32361a6f5afa093b447b788284f91b78d80253dbdcd3962131c854bf85b5a70981c649dc7a90"],
  [257, 8, false, "553ab6c320fc7b98"],
  [257, 8, true, "80a389b704d86c69"],
  [257, 16, false, "7e5b16bfede2940cbed4da50b56da597"],
  [257, 16, true, "ec958fa05f8854cdb6e203e72cdd9329"],
  [257, 32, false, "4ce481b24d387422d2bc2baa03d1afd55a1327939ff537c71eb9b38709268649"],
  [257, 32, true, "bcc3cad1b368507d5127b0af79468bf23c9a0ff2f4225f6e33e55d98a739f5d9"],
  [257, 64, false, "9f1975efca45e7b74b020975d4d2c22802906ed8bfefca51ac497bd23147fc8f303890d8e5471ab6caaa02362e831a9e8d3435279912ccd4842c7806b096c348"],
  [257, 64, true, "b36805fffd1ff25de39aa261108c5546f1a51f631a5270a18fae4931d286bfc4ec955a4e09697891d9a2231dab52db668938cc242c1e8648ce238390ef2e7a5b"],
];

describe("blake2b", () => {
  it.each(VECTORS)("len=%i digest=%i keyed=%s", (n, dl, keyed, hex) => {
    const opts = keyed ? { digestLength: dl, key } : { digestLength: dl };
    expect(blake2bHex(pat(n), opts)).toBe(hex);
  });

  it("matches the fingerprint golden value", () => {
    expect(blake2bHex(utf8Encode("||"), { digestLength: 8 })).toBe("fc552c95a0bb0d3e");
  });

  it("RFC 7693 abc / 64 bytes", () => {
    expect(blake2bHex(utf8Encode("abc"), { digestLength: 64 })).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("max-length key and empty message with short key", () => {
    expect(blake2bHex(utf8Encode("abc"), { digestLength: 16, key: key64 })).toBe("a9f9ff5c38d7eda4899ab27d41b93372");
    expect(blake2bHex(new Uint8Array(0), { digestLength: 32, key: key64.subarray(0, 5) })).toBe(
      "028cb634eb272737809e84e7ccd7af4324f7ce61c04a4910d30f1db25740e461",
    );
  });

  it("1-byte digest and single-byte key", () => {
    expect(blake2bHex(new Uint8Array(0), { digestLength: 1 })).toBe("2e");
    expect(blake2bHex(new Uint8Array(0), { digestLength: 64, key: utf8Encode("k") })).toBe(
      "a393a0e4093eea8bfd03ebe262849654a10fbf67afc7f4f533efc0f992b33cbc574f32066446c2447ef23d5e86fabfd213b9eed79173ee8900909f2da52269cc",
    );
  });

  it("returns a digest of the requested length", () => {
    expect(blake2b(new Uint8Array(3), { digestLength: 20 }).length).toBe(20);
  });

  it("rejects bad parameters", () => {
    expect(() => blake2b(new Uint8Array(0), { digestLength: 0 })).toThrow(RangeError);
    expect(() => blake2b(new Uint8Array(0), { digestLength: 65 })).toThrow(RangeError);
    expect(() => blake2b(new Uint8Array(0), { digestLength: 8, key: new Uint8Array(65) })).toThrow(RangeError);
  });

  it("does not mutate input and is repeatable", () => {
    const d = pat(300);
    const copy = d.slice();
    const a = blake2bHex(d, { digestLength: 16 });
    expect(blake2bHex(d, { digestLength: 16 })).toBe(a);
    expect(d).toEqual(copy);
  });

  it("perf guard: 1000 hashes of 64 KiB stay under 5 s", () => {
    // 64 MB total, ~1.7 s on a dev laptop; the 5 s bound avoids CI flakiness while
    // still catching order-of-magnitude regressions (e.g. accidental BigInt).
    const data = pat(65536);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) blake2b(data, { digestLength: 8 });
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 30000);

  // python3 -c 'import hashlib; d=bytes((i*31+7)&255 for i in range(1<<20)); k=bytes(range(1,33));
  //   print(hashlib.blake2b(d,digest_size=16,key=k).hexdigest())'
  it("keyed hashing of a 1 MiB input", () => {
    const data = new Uint8Array(1 << 20);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 255;
    const k = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    expect(blake2bHex(data, { digestLength: 16, key: k })).toBe("ea1ddd510863e66d1c22929619aa4ed6");
    expect(blake2bHex(data, { digestLength: 64, key: k }).slice(0, 32)).toBe("e1f0f16b715aa56aeb15ba339b3c94d4");
  });
});
