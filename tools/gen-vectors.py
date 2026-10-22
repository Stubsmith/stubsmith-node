#!/usr/bin/env python3
"""Generate golden conformance vectors by calling the reference Python SDK.

Usage:
    PYTHONPATH=/path/to/stubsmith-python python3 tools/gen-vectors.py

Every `expected` value is produced by the SDK (or hashlib / json / urllib for the
primitive vectors). Nothing here is hand-written expected output. Deterministic:
fixed inputs, fixed salts, sorted JSON keys.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sys
import urllib.parse
from pathlib import Path

import stubsmith
from stubsmith import client as sdk_client
from stubsmith._version import __version__
import importlib

fpm = importlib.import_module('stubsmith.privacy.fingerprint')
fr = importlib.import_module('stubsmith.privacy.field_rules')
masking = importlib.import_module('stubsmith.privacy.masking')
placeholders = importlib.import_module('stubsmith.privacy.placeholders')
templating = importlib.import_module('stubsmith.privacy.templating')
from stubsmith.privacy.pipeline import PrivacyPipeline
from stubsmith.privacy.rules_cache import RulesCache

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "conformance" / "vectors"
SDK_ROOT = Path(stubsmith.__file__).resolve().parent.parent

OUT.mkdir(parents=True, exist_ok=True)

# Keep SDK warnings (sync 404 etc.) out of the generator output.
logging.getLogger("stubsmith").addHandler(logging.NullHandler())
logging.getLogger("stubsmith").propagate = False


def write_json_file(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


COUNTS = {}


def emit(filename, description, source, cases):
    names = [c["name"] for c in cases]
    assert len(names) == len(set(names)), f"duplicate case names in {filename}"
    write_json_file(OUT / filename, {"description": description, "source": source, "cases": cases})
    COUNTS[filename] = len(cases)


def typed(v):
    """Language-neutral encoding of a Python scalar (keeps int vs float vs str)."""
    if v is None:
        return {"type": "none"}
    if isinstance(v, bool):
        return {"type": "bool", "value": v}
    if isinstance(v, int):
        return {"type": "int", "text": str(v)}
    if isinstance(v, float):
        return {"type": "float", "text": repr(v)}
    if isinstance(v, str):
        return {"type": "str", "value": v}
    raise TypeError(v)


class env_salt:
    def __init__(self, salt):
        self.salt = salt

    def __enter__(self):
        self.old = os.environ.get("STUBSMITH_MASK_SALT")
        if self.salt is None:
            os.environ.pop("STUBSMITH_MASK_SALT", None)
        else:
            os.environ["STUBSMITH_MASK_SALT"] = self.salt

    def __exit__(self, *a):
        if self.old is None:
            os.environ.pop("STUBSMITH_MASK_SALT", None)
        else:
            os.environ["STUBSMITH_MASK_SALT"] = self.old


# ---------------------------------------------------------------------------
# 1. blake2b
# ---------------------------------------------------------------------------
def gen_blake2b():
    inputs = [
        ("empty", ""), ("ascii", "hello"), ("pipes", "||"),
        ("nonascii-latin", "café naïve"), ("cjk", "日本語"),
        ("astral", "\U0001F600 emoji"), ("a200", "a" * 200), ("b1000", "b" * 1000),
        ("sample-raw", "a,b,b.c,b.c.[],b.c.[].d|x,y|application/json"),
    ]
    keys = [("none", None), ("salt", b"salt"), ("key64", bytes(range(64)))]
    cases = []
    for iname, text in inputs:
        for kname, key in keys:
            for size in (8, 16):
                h = hashlib.blake2b(text.encode("utf-8"), key=key or b"", digest_size=size)
                cases.append({
                    "name": f"{iname}-{kname}-{size}",
                    "input": {"text": text, "utf8_bytes": len(text.encode("utf-8")),
                              "key_hex": key.hex() if key else "", "key_utf8": "salt" if kname == "salt" else None,
                              "digest_size": size},
                    "expected": {"hex": h.hexdigest()},
                })
    emit("blake2b.json", "BLAKE2b digests of UTF-8 text, unkeyed and keyed (key_hex empty means unkeyed).",
         "hashlib.blake2b", cases)


# ---------------------------------------------------------------------------
# 2. fingerprint
# ---------------------------------------------------------------------------
FORM = "application/x-www-form-urlencoded"


def fp_case(name, body="", qs="", ct="", value_paths=None, status=200):
    keypaths = fpm.extract_keypaths(body, ct)
    qnames = fpm.unique_query_names(qs)
    ctn = fpm._normalise_ct(ct)
    pairs = fpm._extract_value_pairs(body, ct, value_paths) if value_paths else []
    raw = ",".join(sorted(keypaths)) + "|" + ",".join(sorted(qnames)) + "|" + ctn
    if value_paths and pairs:
        raw += "|" + ",".join(sorted(pairs))
    raw_resp = ",".join(sorted(keypaths)) + "|" + ",".join(sorted(qnames)) + "|" + ctn
    req_fp = fpm.fingerprint(body, qs, ct, value_paths=value_paths or None)
    assert req_fp == hashlib.blake2b(raw.encode("utf-8"), digest_size=8).hexdigest(), name
    resp_fp = fpm.resp_fingerprint(status, body, qs, ct)
    assert resp_fp == str(status) + hashlib.blake2b(raw_resp.encode("utf-8"), digest_size=8).hexdigest(), name
    inp = {"body": body, "query_string": qs, "content_type": ct, "status": status}
    if value_paths is not None:
        inp["value_paths"] = value_paths
    return {"name": name, "input": inp, "expected": {
        "key_paths": keypaths, "query_names": qnames, "content_type_normalised": ctn,
        "value_pairs": pairs, "raw": raw, "req_fingerprint": req_fp,
        "resp_raw": raw_resp, "resp_fingerprint": resp_fp}}


def gen_fingerprint():
    J = "application/json"
    c = []
    a = c.append
    a(fp_case("golden-empty-all"))
    a(fp_case("golden-nested", '{"a":1,"b":{"c":[1,{"d":2}]}}', "x=1&y=2", "application/json; charset=utf-8"))
    a(fp_case("golden-nested-value", '{"a":1,"b":{"c":[1,{"d":2}]}}', "x=1&y=2", "application/json; charset=utf-8", ["a"]))
    a(fp_case("empty-body-json-ct", "", "", J))
    a(fp_case("whitespace-body", "  \n\t ", "", J))
    a(fp_case("invalid-json", "{not json", "", J))
    a(fp_case("truncated-json", '{"a":', "", J))
    for n, b in [("scalar-int", "42"), ("scalar-string", '"hi"'), ("scalar-null", "null"), ("scalar-true", "true")]:
        a(fp_case("root-" + n, b, "", J))
    a(fp_case("nested-objects", '{"a":{"b":{"c":1,"d":{"e":2}},"f":3},"g":4}', "", J))
    a(fp_case("array-of-objects", '{"items":[{"id":1,"p":2},{"id":3,"q":4}]}', "", J))
    a(fp_case("array-of-scalars", '{"tags":["x","y"]}', "", J))
    a(fp_case("mixed-array", '{"m":[1,{"deep":{"deeper":1}},"s",[{"z":1}]]}', "", J))
    a(fp_case("mixed-array-scalar-first", '{"m":[1,{"k":1}]}', "", J))
    a(fp_case("mixed-array-object-first", '{"m":[{"k":1},1]}', "", J))
    a(fp_case("empty-array", '{"a":[]}', "", J))
    a(fp_case("root-empty-array", "[]", "", J))
    a(fp_case("root-array-of-objects", '[{"id":1},{"name":"x"}]', "", J))
    a(fp_case("root-array-of-scalars", "[1,2,3]", "", J))
    a(fp_case("root-nested-arrays", "[[1,2],[{\"a\":1}]]", "", J))
    a(fp_case("nested-empty-objects", '{"a":{},"b":{"c":{}}}', "", J))
    a(fp_case("array-of-empty-objects", '{"a":[{},{}]}', "", J))
    a(fp_case("dup-keys-last-wins", '{"a":1,"b":2,"a":{"c":1}}', "", J))
    a(fp_case("dup-keys-obj-then-scalar", '{"a":{"c":1},"a":5}', "", J))
    a(fp_case("numeric-like-key-order", '{"b":1,"2":1,"1":1,"a":{"10":1,"9":2}}', "", J))
    a(fp_case("key-with-dot", '{"a.b":1,"a":{"b":2}}', "", J))
    a(fp_case("key-literal-brackets", '{"a":{"[]":1}}', "", J))
    a(fp_case("empty-key", '{"":1,"a":{"":2}}', "", J))
    # form bodies
    a(fp_case("form-basic", "a=1&b=2", "", FORM))
    a(fp_case("form-blank-values", "a=&b=&c", "", FORM))
    a(fp_case("form-repeated-keys", "a=1&a=2&b=3&a=4", "", FORM))
    a(fp_case("form-plus-percent", "a+b=c+d&e%20f=%41%42&g=%2B", "", FORM))
    a(fp_case("form-bare-key", "flag&other=1", "", FORM))
    a(fp_case("form-empty-segments", "a=1&&b=2&", "", FORM))
    a(fp_case("form-semicolon-not-separator", "a=1;b=2&c=3", "", FORM))
    a(fp_case("form-only-ampersands", "&&&", "", FORM))
    a(fp_case("form-brackets-keys", "a[]=1&a[]=2&b[x]=3", "", FORM))
    a(fp_case("form-unicode-keys", "caf%C3%A9=1&%F0%9F%98%80=2&z=3", "", FORM))
    a(fp_case("form-invalid-percent", "a%zz=1&b=%E9", "", FORM))
    a(fp_case("form-equals-in-value", "a=b=c&d==", "", FORM))
    a(fp_case("form-looks-like-json", '{"a":1}', "", FORM))
    a(fp_case("form-whitespace-only", "   ", "", FORM))
    a(fp_case("form-free-text", "Dear SECRET, your PIN is 1234", "", FORM))
    a(fp_case("form-free-text-after-pair", "a=1&Dear SECRET", "", FORM))
    # content-types
    a(fp_case("text-plain-json-body", '{"a":1}', "", "text/plain"))
    a(fp_case("no-ct-json-body", '{"a":1}', "", ""))
    a(fp_case("ct-charset-suffix", '{"a":1}', "", "application/json; charset=UTF-8"))
    a(fp_case("ct-uppercase", '{"a":1}', "", "APPLICATION/JSON"))
    a(fp_case("ct-spaces-around", '{"a":1}', "", "  Application/Json  ;charset=utf-8"))
    a(fp_case("ct-form-uppercase-charset", "a=1&b=2", "", "Application/X-WWW-Form-Urlencoded; Charset=UTF-8"))
    a(fp_case("ct-multipart-boundary-json-body", '{"a":1}', "", "multipart/form-data; boundary=----x"))
    a(fp_case("ct-image-png-with-json-body", '{"a":1}', "", "image/png"))
    a(fp_case("ct-semicolon-only", '{"a":1}', "", ";charset=utf-8"))
    # queries
    for n, q in [
        ("qs-basic", "a=1&b=2"), ("qs-repeated", "a=1&a=2&b=3"), ("qs-blank", "a=&b"),
        ("qs-empty-segments", "a=1&&b=2"), ("qs-semicolon", "a=1;b=2"), ("qs-plus-percent", "a+b=1&c%20d=2"),
        ("qs-bare-keys", "x&y&x"), ("qs-unicode", "caf%C3%A9=1&%F0%9F%98%80=2"), ("qs-brackets", "a[]=1&a[]=2"),
        ("qs-leading-question-mark", "?a=1"), ("qs-trailing-amp", "a=1&"),
        ("qs-order-differs-from-sorted", "z=1&a=2&m=3"),
    ]:
        a(fp_case(n, "", q, ""))
    a(fp_case("qs-with-json-body", '{"k":1}', "z=1&a=2", J))
    # code-point vs UTF-16 order
    a(fp_case("codepoint-order-astral-vs-bmp", '{"z":1,"\U0001F600":2,"�":3,"":4}', "", J))
    a(fp_case("codepoint-order-astral-query", "", "\U0001F600=1&�=2&z=3&%EF%BF%BD=4", ""))
    a(fp_case("codepoint-order-form", "%F0%9F%98%80=1&%EF%BF%BD=2&z=3", "", FORM))
    a(fp_case("codepoint-order-astral-vs-bmp-high", '{"～":1,"\U00010000":2,"\U0001F600":3}', "", J))
    # response statuses
    a(fp_case("status-404", '{"error":"x"}', "", J, status=404))
    a(fp_case("status-500-empty", "", "", "", status=500))
    # value discrimination
    vb = ('{"t":true,"f":false,"i":7,"n":-7,"big":9223372036854775808,"huge":123456789012345678901234567890,'
          '"f1":1.0,"f15":1.5,"e16":1e16,"em7":1e-7,"sum":0.30000000000000004,"nz":-0.0,'
          '"e2":1E2,"s":"str","nl":null,"o":{"x":1},"a":[1,2],"nested":{"v":5,"w":{"x":"y"}},'
          '"arr":[{"v":1}],"emptys":"","uni":"caf\\u00e9","nan":NaN,"inf":Infinity,"ninf":-Infinity}')
    for p in ["t", "f", "i", "n", "big", "huge", "f1", "f15", "e16", "em7", "sum", "nz", "e2", "s", "nl", "o", "a",
              "nested.v", "nested.w", "nested.w.x", "missing", "nested.missing", "arr.[].v", "arr.0.v", "a.0",
              "emptys", "uni", "nan", "inf", "ninf", "s.x"]:
        a(fp_case("value-" + p.replace(".", "_").replace("[]", "arr"), vb, "", J, [p]))
    a(fp_case("value-multi-sorted", vb, "", J, ["s", "i", "t", "missing"]))
    a(fp_case("value-multi-none-hit", vb, "", J, ["missing", "o", "a"]))
    a(fp_case("value-empty-list", vb, "", J, []))
    a(fp_case("value-duplicate-path", vb, "", J, ["i", "i"]))
    a(fp_case("value-string-with-comma-eq", '{"s":"a,b=c"}', "", J, ["s"]))
    a(fp_case("value-root-array-body", "[1,2]", "", J, ["a"]))
    a(fp_case("value-root-scalar-body", "5", "", J, ["a"]))
    a(fp_case("value-invalid-json", "{bad", "", J, ["a"]))
    a(fp_case("value-dup-key-last-wins", '{"a":1,"a":2}', "", J, ["a"]))
    a(fp_case("value-text-plain-json", '{"a":"x"}', "", "text/plain", ["a"]))
    a(fp_case("value-form", "a=1&b=&c=x+y&a=2&n=%2B", "", FORM, ["a", "b", "c", "n", "missing"]))
    a(fp_case("value-form-dotted-key", "a.b=1&a=2", "", FORM, ["a.b"]))
    a(fp_case("value-form-keypath-style", "a=1", "", FORM, ["a.[]"]))
    a(fp_case("value-form-with-query", "a=1&b=2", "q=1", FORM, ["b"]))
    a(fp_case("value-form-free-text", "a=1&Dear SECRET", "", FORM, ["a", "Dear SECRET"]))
    emit("fingerprint.json",
         "Key paths, query names, content-type normalisation, hash input string (raw) and request/response fingerprints. "
         "input.status applies to resp_fingerprint only; resp fingerprint uses the same body/query/content_type and never value pairs.",
         "stubsmith.privacy.fingerprint.extract_keypaths, unique_query_names, _normalise_ct, _extract_value_pairs, fingerprint, resp_fingerprint",
         c)


# ---------------------------------------------------------------------------
# 3. templating
# ---------------------------------------------------------------------------
def tpl_case(name, path, templates=()):
    cur = templating.load_curated_templates(list(templates))
    return {"name": name, "input": {"path": path, "templates": list(templates)}, "expected": {
        "sorted_templates": [{"template": t.template, "literal_count": t.literal_count} for t in cur],
        "template": templating.template_path(path, cur)}}


def gen_templating():
    c = []
    a = c.append
    T = ["/users/{id}", "/users/{id}/orders", "/users/me/orders", "/users/{id}/orders/{oid}", "/{a}/{b}", "/users/me"]
    a(tpl_case("curated-wildcard", "/users/5", T))
    a(tpl_case("curated-literal-beats-wildcard", "/users/me", T))
    a(tpl_case("curated-literal-count-ordering", "/users/me/orders", T))
    a(tpl_case("curated-wildcard-mid", "/users/77/orders", T))
    a(tpl_case("curated-three-segments", "/users/1/orders/2", T))
    a(tpl_case("curated-generic-two-segments", "/foo/bar", T))
    a(tpl_case("curated-no-match-falls-back", "/foo/bar/baz/123", T))
    a(tpl_case("curated-mismatch-too-few", "/users", ["/users/{id}"]))
    a(tpl_case("curated-mismatch-too-many", "/users/1/2", ["/users/{id}"]))
    a(tpl_case("tie-lexicographic", "/x/y", ["/x/{b}", "/{a}/y", "/x/{a}"]))
    a(tpl_case("tie-lexicographic-literal", "/a/b", ["/b/{x}", "/a/{x}", "/{x}/b"]))
    a(tpl_case("tie-same-literal-count-different-position", "/p/q/r", ["/p/{x}/r", "/{x}/q/r", "/p/q/{x}"]))
    a(tpl_case("wildcard-named-camel", "/u/9", ["/u/{userId}"]))
    a(tpl_case("wildcard-empty-braces-not-wildcard", "/u/9", ["/u/{}"]))
    a(tpl_case("wildcard-empty-braces-literal-match", "/u/{}", ["/u/{}"]))
    a(tpl_case("wildcard-nested-braces-not-wildcard", "/u/9", ["/u/{a{b}}"]))
    a(tpl_case("wildcard-partial-not-wildcard", "/u/id-9", ["/u/id-{id}"]))
    a(tpl_case("wildcard-matches-anything-incl-unicode", "/u/é", ["/u/{id}"]))
    a(tpl_case("trailing-slash-path", "/users/5/", ["/users/{id}"]))
    a(tpl_case("trailing-slash-template", "/users/5", ["/users/{id}/"]))
    a(tpl_case("double-slash-path", "/users//5", ["/users/{id}"]))
    a(tpl_case("double-slash-path-heuristic", "//users//123//", []))
    a(tpl_case("template-without-leading-slash", "/users/5", ["users/{id}"]))
    a(tpl_case("template-all-wildcards", "/a/b", ["/{x}/{y}"]))
    a(tpl_case("template-root", "/", ["/"]))
    a(tpl_case("template-empty-string", "", [""]))
    a(tpl_case("path-root-with-curated", "/", ["/users/{id}"]))
    a(tpl_case("case-sensitive-literal", "/Users/5", ["/users/{id}"]))
    a(tpl_case("duplicate-templates", "/a/1", ["/a/{id}", "/a/{id}"]))
    # heuristic
    H = [
        ("ascii-digits", "/orders/12345"), ("ascii-digit-single", "/v/1"), ("leading-zero", "/o/007"),
        ("unicode-arabic-digits", "/o/٣٤"), ("superscript-two", "/o/²"), ("roman-numeral", "/o/Ⅷ"),
        ("fullwidth-digits", "/o/１２"), ("devanagari-digits", "/o/१२"),
        ("circled-digit", "/o/①"), ("vulgar-fraction", "/o/½"),
        ("digits-with-sign", "/o/-5"), ("digits-with-dot", "/o/1.5"), ("digits-with-letter", "/o/12a"),
        ("uuid-lower", "/o/123e4567-e89b-12d3-a456-426614174000"), ("uuid-upper", "/o/123E4567-E89B-12D3-A456-426614174000"),
        ("uuid-mixed", "/o/123e4567-E89B-12d3-A456-426614174000"),
        ("uuid-bad-group", "/o/123e4567-e89b-12d3-a456-42661417400"),
        ("uuid-no-dashes-32", "/o/123e4567e89b12d3a456426614174000"),
        ("hex-15", "/o/abcdef012345678"), ("hex-16", "/o/abcdef0123456789"), ("hex-17", "/o/abcdef01234567890"),
        ("hex-16-upper", "/o/ABCDEF0123456789"), ("hex-16-mixed", "/o/AbCdEf0123456789"),
        ("hex-16-with-g", "/o/abcdef012345678g"), ("hex-15-digits-only", "/o/123456789012345"),
        ("hex-letters-only-16", "/o/abcdefabcdefabcd"),
        ("hex-word-feed", "/o/deadbeef"), ("hex-word-long-nonhex", "/o/abcdefghijklmnop"),
        ("percent-encoded-digits", "/o/%31%32"), ("percent-encoded-uuid", "/o/123e4567%2De89b-12d3-a456-426614174000"),
        ("percent-encoded-space", "/o/a%20b"),
        ("empty-path", ""), ("root", "/"), ("trailing-slash", "/o/123/"), ("double-slash", "/o//123"),
        ("multi-ids", "/a/1/b/2/c/3"), ("mixed-literals", "/users/5/orders/abc"),
        ("no-leading-slash", "users/5"), ("query-like-in-path", "/o/5?x=1"), ("dot-segment", "/o/../5"),
        ("non-ascii-literal", "/café/42"), ("hex-16-unicode-lookalike", "/o/abcdef012345678١"),
        ("kelvin-sign-hex-16", "/o/abcdef012345678K"), ("long-digit-run", "/o/" + "9" * 40),
    ]
    for n, p in H:
        a(tpl_case("heuristic-" + n, p, []))
    emit("templating.json",
         "Curated template ordering/matching and heuristic fallback. expected.sorted_templates is the load_curated_templates order.",
         "stubsmith.privacy.templating.load_curated_templates, template_path", c)


# ---------------------------------------------------------------------------
# 4. classify
# ---------------------------------------------------------------------------
def gen_classify():
    c = []
    a = c.append

    def sc(name, src):
        v = json.loads(src)
        a({"name": name, "input": {"op": "classify_scalar", "json": src}, "expected": {"label": fpm.classify_scalar(v)}})

    def vt(name, body, ct):
        a({"name": name, "input": {"op": "extract_value_types", "body": body, "content_type": ct},
           "expected": {"value_types": fpm.extract_value_types(body, ct)}})

    for n, s in [
        ("int-1", "1"), ("int-0", "0"), ("int-negative", "-5"), ("int-big", "9223372036854775808"),
        ("int-huge", "123456789012345678901234567890"), ("float-1.0", "1.0"), ("float-1.5", "1.5"),
        ("float-1e2", "1e2"), ("float-1E2", "1E2"), ("float-neg", "-0.5"), ("float-neg-zero", "-0.0"),
        ("float-e-neg", "1e-7"), ("bool-true", "true"), ("bool-false", "false"), ("null", "null"),
        ("nan", "NaN"), ("infinity", "Infinity"),
    ]:
        sc("scalar-" + n, s)
    S = {
        "uuid-lower": "123e4567-e89b-12d3-a456-426614174000", "uuid-upper": "123E4567-E89B-12D3-A456-426614174000",
        "uuid-trailing-newline": "123e4567-e89b-12d3-a456-426614174000\n",
        "email": "alice@example.com", "email-plus": "a.b+c@sub.example.co", "email-trailing-newline": "a@b.co\n",
        "email-no-tld": "a@b", "email-short-tld": "a@b.c", "email-unicode-local": "é@example.com",
        "iso-date": "2024-01-31", "iso-datetime-T": "2024-01-31T10:20:30Z", "iso-datetime-space": "2024-01-31 10:20",
        "iso-date-trailing-newline": "2024-01-31\n", "iso-datetime-prefix-only": "2024-01-31T10:20 garbage",
        "iso-date-garbage-suffix": "2024-01-31x", "iso-fullwidth-digits": "２０２４-01-31",
        "iso-arabic-digits": "٢٠٢٤-٠١-٣١",
        "iso-month-13": "2024-13-45", "iso-time-only": "10:20:30",
        "e164": "+31612345678", "e164-short": "+123456", "e164-min7": "+1234567", "e164-max15": "+123456789012345",
        "e164-16": "+1234567890123456", "e164-no-plus": "31612345678", "e164-trailing-newline": "+31612345678\n",
        "iban": "NL91ABNA0417164300", "iban-lower": "nl91abna0417164300", "iban-short": "EU20240001",
        "iban-trailing-newline": "NL91ABNA0417164300\n", "iban-min-15": "NO9386011117947",
        "url-http": "http://example.com", "url-https": "https://example.com/a?b=1", "url-upper": "HTTPS://example.com",
        "url-ftp": "ftp://example.com", "url-bare": "https://",
        "currency": "EUR", "currency-lower": "eur", "country": "NL", "country-lower": "nl",
        "currency-trailing-newline": "EUR\n", "country-trailing-newline": "NL\n",
        "int-string": "42", "int-string-negative": "-42", "int-string-zero-pad": "007", "int-string-plus": "+42",
        "int-string-trailing-newline": "42\n", "int-string-unicode-digits": "٣٤", "int-string-superscript": "²",
        "int-string-roman": "Ⅷ", "int-string-fullwidth": "１２",
        "decimal-string": "12.50", "decimal-string-negative": "-0.5", "decimal-string-no-int": ".5",
        "decimal-string-no-frac": "5.", "decimal-string-two-dots": "1.2.3", "decimal-string-exp": "1e5",
        "decimal-string-trailing-newline": "1.5\n",
        "free-text": "hello world", "free-empty": "", "free-space": " ", "free-hex": "deadbeefdeadbeefdeadbeef",
        "free-mixed-case-token": "AbC123xyz", "free-unicode": "café", "free-emoji": "\U0001F600",
        "free-three-letter-mixed": "Eur", "free-two-letter-digit": "N1", "free-newline-only": "\n",
        "free-uuid-no-dashes": "123e4567e89b12d3a456426614174000",
    }
    for n, s in S.items():
        sc("string-" + n, json.dumps(s))
    for n, s in [("object", '{"a":1}'), ("array", "[1]")]:
        # not reachable via leaves; classify_scalar returns None for containers
        sc("container-" + n, s)
    J = "application/json"
    vt("body-json-types", '{"i":1,"f":1.0,"e":1e2,"n":-3,"s":"hi","em":"a@b.co","id":"123e4567-e89b-12d3-a456-426614174000",'
       '"b":true,"z":null,"o":{"d":"2024-01-01","u":"https://x.io"},"arr":[{"p":"12.50"},{"p":"7"}],'
       '"sc":["a",2],"cur":"EUR"}', J)
    vt("body-json-array-last-wins", '{"a":[{"v":1},{"v":"x"},{"v":null},{"v":true}]}', J)
    vt("body-json-scalar-array-last-wins", '{"a":[1,"x",null,2.5]}', J)
    vt("body-json-all-skipped", '{"a":true,"b":null,"c":[true,null]}', J)
    vt("body-json-root-array", '[{"a":"x"},3]', J)
    vt("body-json-root-scalar", "42", J)
    vt("body-json-empty-containers", '{"a":{},"b":[]}', J)
    vt("body-json-dup-keys", '{"a":1,"a":"x"}', J)
    vt("body-json-nested-array-in-array", '{"a":[[1,2],[{"b":"x"}]]}', J)
    vt("body-json-text-plain", '{"a":"x"}', "text/plain")
    vt("body-json-no-ct", '{"a":"x"}', "")
    vt("body-invalid", "{bad", J)
    vt("body-empty", "", J)
    vt("body-whitespace", "  ", J)
    vt("body-form-first-value", "a=1&a=x&b=2024-01-01&c=&d=a%40b.co&e=1.5&f=EUR&g=hello+world&h=%2B31612345678", FORM)
    vt("body-form-blank", "a=&b", FORM)
    vt("body-form-bare-key", "flag&x=1", FORM)
    vt("body-form-ct-uppercase", "a=1", "APPLICATION/X-WWW-FORM-URLENCODED; charset=utf-8")
    vt("body-form-looks-like-json", '{"a":1}', FORM)
    vt("body-form-free-text", "Dear SECRET, your PIN is 1234", FORM)
    emit("classify.json",
         "classify_scalar over JSON source tokens (input.json is parsed with json.loads, so 1 is int and 1.0/1e2 are float; "
         "label null means no label) and extract_value_types over JSON and form bodies. Note the SDK regexes use Python "
         "semantics: $ matches before a trailing newline and \\d in the ISO pattern matches Unicode digits.",
         "stubsmith.privacy.fingerprint.classify_scalar, extract_value_types", c)


# ---------------------------------------------------------------------------
# 5. placeholders
# ---------------------------------------------------------------------------
def gen_placeholders():
    salts = [("test-salt", "test-salt-123"), ("empty", ""), ("long70", "k" * 70),
             ("multibyte-trunc", "€" * 30)]
    values = [
        ("str-hello", "hello"), ("str-int-like", "42"), ("str-email", "alice@example.com"), ("str-empty", ""),
        ("str-unicode", "héllo \U0001F600"), ("str-decimal", "12.50"),
        ("int-12345", 12345), ("int-0", 0), ("int-negative", -7), ("int-2pow63", 2 ** 63), ("int-big", 10 ** 30),
        ("float-12.5", 12.5), ("float-1.0", 1.0), ("float-0.1", 0.1), ("float-1e16", 1e16), ("float-1e-7", 1e-7),
        ("float-neg-zero", -0.0), ("float-0.1p0.2", 0.1 + 0.2),
        ("bool-true", True), ("bool-false", False), ("none", None),
    ]
    labels = sorted(placeholders.SEMANTIC_TYPE_VOCAB) + ["bogus_label", ""]
    c = []
    for sname, salt in salts:
        for label in labels:
            for vname, v in values:
                domains = [None, "example.invalid"] if label == "email" else [None]
                for dom in domains:
                    with env_salt(salt):
                        key = placeholders.get_salt()
                    out = placeholders.generate(label, v, key, email_domain=dom)
                    c.append({
                        "name": f"{sname}/{label or 'EMPTYLABEL'}/{vname}" + (f"/domain" if dom else ""),
                        "input": {"semantic_type": label, "value": typed(v), "salt": salt, "email_domain": dom},
                        "expected": {"salt_key_hex": key.hex() if key is not None else None, "output": typed(out)}})
    emit("placeholders.json",
         "Format-preserving placeholder generation. input.salt is the STUBSMITH_MASK_SALT string (empty or absent means no key; "
         "key is its UTF-8 bytes truncated to 64 bytes, see expected.salt_key_hex). Values and outputs use a typed encoding "
         "({type: str|int|float|bool|none, value|text}) so int vs float survives; float text is Python repr. "
         "email_domain null means default (stub.invalid).",
         "stubsmith.privacy.placeholders.generate, get_salt", c)


# ---------------------------------------------------------------------------
# 6. mask-all
# ---------------------------------------------------------------------------
def ma_case(name, body="", headers=None, query="", ct=""):
    headers = headers or {}
    mb, mh, mq = masking.mask_all(body, headers, query, ct)
    return {"name": name, "input": {"body": body, "headers": headers, "query": query, "content_type": ct},
            "expected": {"body": mb, "headers": mh, "query": mq}}


def gen_mask_all():
    J = "application/json"
    c = []
    a = c.append
    a(ma_case("headers-allowlist-all", headers={k: "v-" + k for k in sorted(masking.HEADER_ALLOWLIST)}))
    a(ma_case("headers-not-allowlisted", headers={"Authorization": "Bearer abc", "X-Api-Key": "k", "Cookie": "s=1", "Set-Cookie": "a=b"}))
    a(ma_case("headers-case-variations", headers={"Content-Type": "application/json", "CONTENT-LENGTH": "12", "User-AGENT": "ua",
                                                 "ACCEPT": "*/*", "Host": "h", "cache-CONTROL": "no-cache", "Authorization": "x", "AUTHORIZATION": "y"}))
    a(ma_case("headers-empty-value", headers={"Accept": "", "X-Empty": ""}))
    a(ma_case("headers-nonstring-values", headers={"Content-Length": 12, "X-Num": 5}))
    a(ma_case("headers-lookalike-names", headers={"content-type ": "a", "x-content-type": "b", "content_type": "c"}))
    for n, b in [
        ("json-strings", '{"a":"x","b":"y"}'), ("json-numbers", '{"i":1,"f":1.5,"n":-3,"e":1e16,"big":9223372036854775808}'),
        ("json-bools", '{"t":true,"f":false}'), ("json-nulls", '{"n":null}'),
        ("json-nested", '{"a":{"b":{"c":"x","d":[1,"y",null,true,{"e":2.5}]}}}'),
        ("json-arrays-root", '[1,"a",null,false,[2],{"k":"v"}]'), ("json-empty-containers", '{"a":{},"b":[],"c":[[]]}'),
        ("json-root-string", '"hello"'), ("json-root-int", "42"), ("json-root-float", "1.5"), ("json-root-null", "null"),
        ("json-root-true", "true"), ("json-nonascii-keys", '{"café":"x","\U0001F600":"y","日本":1}'),
        ("json-nonascii-values", '{"a":"café \U0001F600"}'), ("json-dup-keys", '{"a":1,"b":"x","a":"y"}'),
        ("json-key-order-preserved", '{"z":1,"a":2,"m":{"y":1,"b":2}}'),
        ("json-numeric-like-keys", '{"b":1,"2":1,"1":1}'), ("json-nan", '{"a":NaN,"b":Infinity}'),
        ("json-escaped-keys", '{"a\\"b":"x","c\\\\d":"y","e\\nf":"z","tab\\t":1,"\\u0001":2,"\\u2028":3,"\\u007f":4}'),
        ("json-whitespace-formatted", '  {\n  "a" :  "x" ,\n "b": [ 1 , 2 ]\n}  '),
        ("json-empty-key", '{"":"x"}'), ("json-empty-object", "{}"), ("json-empty-array", "[]"),
    ]:
        a(ma_case(n, b, ct=J))
    a(ma_case("json-body-no-ct", '{"a":"x"}', ct=""))
    a(ma_case("json-body-text-plain", '{"a":"x"}', ct="text/plain"))
    a(ma_case("json-body-ct-charset", '{"a":"x"}', ct="application/json; charset=utf-8"))
    for n, b in [
        ("form-basic", "a=1&b=2"), ("form-blank", "a=&b=&c"), ("form-repeated", "a=1&a=2&a=3&b=4"),
        ("form-plus-percent", "a+b=c+d&e%20f=%41"), ("form-empty-segments", "a=1&&b=2&"), ("form-semicolon", "a=1;b=2&c=3"),
        ("form-unicode-key", "caf%C3%A9=1&%F0%9F%98%80=2"), ("form-brackets", "a[]=1&a[]=2&b[x]=3"),
        ("form-special-key-chars", "a/b=1&c~d=2&e!f=3&g*h=4&i'j=5&k(l)=6"), ("form-plus-in-key", "a%2Bb=1"),
        ("form-equals-in-key", "a%3Db=1"), ("form-looks-like-json", '{"a":"x"}'), ("form-empty-body", ""),
        ("form-whitespace", "   "), ("form-only-ampersand", "&&"),
        ("form-free-text", "Dear SECRET, your PIN is 1234"), ("form-free-text-after-pair", "a=1&Dear SECRET"), ("form-invalid-percent", "a%zz=1&%E9=2"),
    ]:
        a(ma_case(n, b, ct=FORM))
    a(ma_case("form-ct-uppercase", "a=1&b=2", ct="APPLICATION/X-WWW-FORM-URLENCODED; charset=utf-8"))
    a(ma_case("form-ct-spaces", "a=1", ct=" application/x-www-form-urlencoded "))
    a(ma_case("form-body-json-ct", "a=1&b=2", ct=J))
    for n, b in [("unparseable-text", "hello world"), ("unparseable-truncated-json", '{"a":'), ("unparseable-xml", "<a>1</a>"),
                 ("unparseable-base64", "iVBORw0KGgo="), ("unparseable-single-quotes", "{'a':1}"), ("unparseable-trailing-comma", '{"a":1,}'),
                 ("unparseable-leading-bom", '﻿{"a":1}'), ("unparseable-trailing-garbage", '{"a":1} x')]:
        a(ma_case(n, b, ct=J))
        a(ma_case(n + "-text-plain", b, ct="text/plain"))
    a(ma_case("empty-body-json-ct", "", ct=J))
    a(ma_case("empty-body-no-ct", "", ct=""))
    a(ma_case("empty-body-text-plain", "", ct="text/plain"))
    a(ma_case("empty-body-form-ct", "", ct=FORM))
    a(ma_case("whitespace-body-json-ct", "   ", ct=J))
    a(ma_case("image-ct-with-body", "rawbytes", ct="image/png"))
    for n, q in [
        ("query-basic", "a=1&b=2"), ("query-empty", ""), ("query-blank", "a=&b"), ("query-repeated", "a=1&a=2&b=3"),
        ("query-plus-percent", "a+b=c+d&e%20f=%41"), ("query-empty-segments", "a=1&&b=2&"), ("query-semicolon", "a=1;b=2"),
        ("query-unicode", "caf%C3%A9=1&%F0%9F%98%80=2"), ("query-brackets", "a[]=1&a[]=2"),
        ("query-only-ampersand", "&&"), ("query-leading-qmark", "?a=1"), ("query-special-chars", "a/b=1&c~d=2&e!f=3&g*h=4&i'j=5&k(l)=6"),
        ("query-invalid-percent", "a%zz=1&%E9=2"), ("query-equals-in-key", "a%3Db=1"),
    ]:
        a(ma_case(n, "", query=q))
    a(ma_case("combined", '{"a":"x"}', {"Authorization": "t", "Accept": "*/*"}, "k=v&k=w", J))
    emit("mask-all.json",
         "mask_all fail-closed masking. Output bodies are Python json.dumps text (default separators ', ' and ': ', "
         "ensure_ascii=True) or urlencode(doseq=True) text; compare byte-exact if byte-identical output is required.",
         "stubsmith.privacy.masking.mask_all", c)


# ---------------------------------------------------------------------------
# 7. copy existing vectors
# ---------------------------------------------------------------------------
def copy_field_rules_vectors():
    src = SDK_ROOT / "tests" / "vectors" / "field-rules-vectors.json"
    shutil.copyfile(src, OUT / "field-rules-vectors.json")
    COUNTS["field-rules-vectors.json"] = len(json.loads(src.read_text(encoding="utf-8"))["vectors"])


SHARED_VECTOR_FILES = ("masking-vectors.json", "masking-pipeline-vectors.json", "masking-values-vectors.json",
                       "fail-closed-vectors.json")


def copy_shared_vectors():
    # Authored in the SDK (tools/gen_shared_vectors.py there); copied byte for byte, never edited here.
    for name in SHARED_VECTOR_FILES:
        src = SDK_ROOT / "tests" / "vectors" / name
        shutil.copyfile(src, OUT / name)
        COUNTS[name] = len(json.loads(src.read_text(encoding="utf-8"))["cases"])


# ---------------------------------------------------------------------------
# 8. field-rules-extra
# ---------------------------------------------------------------------------
def fr_case(name, field_rules, body="", ct="", headers=None, query="", resp_body="", resp_ct="", resp_headers=None,
            resp_status=None, salt=None, email_domain=None, project_defaults=None):
    headers = headers or {}
    resp_headers = resp_headers or {}
    comp = fr.compile_field_rules(field_rules)
    extra = None
    if project_defaults is not None:
        extra = masking.compile_rules(project_defaults.get("field_masks") or [], project_defaults.get("regex_masks") or [])
        if not (extra.field_masks or extra.regex_masks or extra.unusable):
            extra = None  # mirrors rules_cache: empty defaults are stored as None
    with env_salt(salt):
        mb, mh, mq = fr.apply_field_rules(body, headers, query, ct, comp, extra_rules=extra, email_domain=email_domain)
        rb, rh = fr.apply_resp_field_rules(resp_body, resp_headers, resp_ct, comp, extra_rules=extra,
                                           resp_status=resp_status, email_domain=email_domain)
    inp = {"field_rules": field_rules, "body": body, "content_type": ct, "headers": headers, "query": query,
           "resp_body": resp_body, "resp_content_type": resp_ct, "resp_headers": resp_headers,
           "resp_status": resp_status, "salt": salt, "email_domain": email_domain, "project_defaults": project_defaults}
    return {"name": name, "input": inp, "expected": {
        "masked_body": mb, "masked_headers": mh, "masked_query": mq, "masked_resp_body": rb, "masked_resp_headers": rh}}


def gen_field_rules_extra():
    J = "application/json"
    K = lambda p: {"path": p, "action": "keep"}
    M = lambda p, t=None: ({"path": p, "action": "mask", "type": t} if t else {"path": p, "action": "mask"})
    RB = '{"id":"o1","error":"nf","detail":"gone","n":5}'
    c = []
    a = c.append
    # status scoped
    a(fr_case("scoped-keep-200-applies", [K("resp:200.id")], resp_body=RB, resp_ct=J, resp_status=200))
    a(fr_case("scoped-keep-200-not-for-404", [K("resp:200.id")], resp_body=RB, resp_ct=J, resp_status=404))
    a(fr_case("scoped-mask-404-overrides-generic-keep", [K("resp.id"), K("resp.error"), M("resp:404.id")],
              resp_body=RB, resp_ct=J, resp_status=404))
    a(fr_case("scoped-mask-404-generic-keep-still-200", [K("resp.id"), M("resp:404.id")], resp_body=RB, resp_ct=J, resp_status=200))
    a(fr_case("scoped-keep-and-mask-same-status-mask-wins", [K("resp:404.id"), M("resp:404.id")], resp_body=RB, resp_ct=J, resp_status=404))
    a(fr_case("scoped-mask-then-keep-order-mask-wins", [M("resp:404.id"), K("resp:404.id")], resp_body=RB, resp_ct=J, resp_status=404))
    a(fr_case("scoped-no-status-passed-ignores-scoped", [K("resp:200.id"), K("resp.error")], resp_body=RB, resp_ct=J, resp_status=None))
    for n, p in [("two-digits", "resp:20.id"), ("four-digits", "resp:0404.id"), ("alpha", "resp:abc.id"), ("600", "resp:600.id"),
                 ("099", "resp:099.id"), ("no-subpath", "resp:404"), ("empty-subpath", "resp:404."),
                 ("unicode-digits", "resp:٢٠٠.id"), ("superscript", "resp:²°⁰.id"),
                 ("plus-sign", "resp:+20.id"), ("space", "resp: 20.id"), ("dot-in-status", "resp:2.0.id")]:
        a(fr_case("scoped-invalid-" + n, [K(p)], resp_body=RB, resp_ct=J, resp_status=200))
    a(fr_case("scoped-boundary-100", [K("resp:100.id")], resp_body=RB, resp_ct=J, resp_status=100))
    a(fr_case("scoped-boundary-599", [K("resp:599.id")], resp_body=RB, resp_ct=J, resp_status=599))
    a(fr_case("scoped-nested-path-with-dots", [K("resp:404.a.b")], resp_body='{"a":{"b":"x","c":"y"}}', resp_ct=J, resp_status=404))
    a(fr_case("scoped-array-path", [K("resp:200.items.[].id")], resp_body='{"items":[{"id":1,"n":2},{"id":3}]}', resp_ct=J, resp_status=200))
    a(fr_case("path-namespace-ignored", [K("path.id"), K("path.{id}"), K("resp.id")], resp_body=RB, resp_ct=J, resp_status=200))
    a(fr_case("unknown-namespace-ignored", [K("foo.id"), K("id"), K("")], body='{"id":1}', ct=J, resp_body=RB, resp_ct=J))
    a(fr_case("missing-action-defaults-mask", [{"path": "resp.id"}], resp_body=RB, resp_ct=J))
    a(fr_case("unknown-action-is-mask", [{"path": "resp.id", "action": "KEEP"}], resp_body=RB, resp_ct=J))
    a(fr_case("scoped-header-keep", [K("resp_header:200.X-Trace")], resp_headers={"X-Trace": "t1", "X-Other": "o"}, resp_status=200))
    a(fr_case("scoped-header-keep-other-status", [K("resp_header:200.X-Trace")], resp_headers={"X-Trace": "t1"}, resp_status=500))
    a(fr_case("scoped-header-mask-overrides-allowlist-not", [M("resp_header:200.content-type")],
              resp_headers={"Content-Type": "application/json"}, resp_status=200))
    a(fr_case("scoped-header-mask-overrides-generic-keep", [K("resp_header.x-trace"), M("resp_header:404.x-trace")],
              resp_headers={"X-Trace": "t1"}, resp_status=404))
    a(fr_case("scoped-header-invalid-status", [K("resp_header:20.x-trace")], resp_headers={"X-Trace": "t1"}, resp_status=200))
    # type hints
    SALT = "test-salt-123"
    body = ('{"email":"alice@example.com","id":"550e8400-e29b-41d4-a716-446655440000","ts":"2024-01-31T10:20:30Z",'
            '"phone":"+31612345678","iban":"NL91ABNA0417164300","url":"https://example.com/x","amt":12.5,"amt_s":"12.50","amt_i":12,'
            '"uid":42,"uid_s":"42","tok":"abc","free":"hello","cur":"EUR","cty":"NL","flag":true,"nul":null,"mism":99}')
    rules = [M("body.email", "email"), M("body.id", "uuid"), M("body.ts", "iso8601"), M("body.phone", "e164"),
             M("body.iban", "iban"), M("body.url", "url"), M("body.amt", "decimal_amount"), M("body.amt_s", "decimal_amount"),
             M("body.amt_i", "decimal_amount"), M("body.uid", "integer_id"), M("body.uid_s", "integer_id"),
             M("body.tok", "opaque_token"), M("body.free", "free_text"), M("body.cur", "currency_code"),
             M("body.cty", "country_code"), M("body.flag", "uuid"), M("body.nul", "email"), M("body.mism", "email")]
    a(fr_case("hints-with-salt-all-types", rules, body=body, ct=J, salt=SALT))
    a(fr_case("hints-with-salt-custom-email-domain", rules, body=body, ct=J, salt=SALT, email_domain="example.invalid"))
    a(fr_case("hints-without-salt-constants", rules, body=body, ct=J, salt=None))
    a(fr_case("hints-empty-salt-constants", rules, body=body, ct=J, salt=""))
    a(fr_case("hints-unknown-label-is-free-text", [M("body.free", "nonsense")], body='{"free":"hello"}', ct=J, salt=SALT))
    a(fr_case("hints-ignored-on-keep-rule", [{"path": "body.email", "action": "keep", "type": "email"}], body='{"email":"x"}', ct=J, salt=SALT))
    a(fr_case("hints-kept-path-wins-over-hint", [K("body.email"), M("body.email", "uuid")], body='{"email":"x"}', ct=J, salt=SALT))
    a(fr_case("hints-last-duplicate-wins", [M("body.v", "uuid"), M("body.v", "email")], body='{"v":"x"}', ct=J, salt=SALT))
    a(fr_case("hints-empty-type-ignored", [{"path": "body.v", "action": "mask", "type": ""}], body='{"v":"x"}', ct=J, salt=SALT))
    a(fr_case("hints-in-arrays", [M("body.items.[].email", "email"), M("body.ids.[]", "integer_id")],
              body='{"items":[{"email":"a@b.co"},{"email":"c@d.co"},{"email":"a@b.co"}],"ids":[1,2,1]}', ct=J, salt=SALT))
    a(fr_case("hints-form-body", [M("body.email", "email"), M("body.n", "integer_id"), M("body.amt", "decimal_amount")],
              body="email=a%40b.co&n=42&n=43&amt=12.50&other=x", ct=FORM, salt=SALT))
    a(fr_case("hints-form-body-no-salt", [M("body.email", "email")], body="email=a%40b.co", ct=FORM))
    a(fr_case("hints-query", [M("query.e", "email"), M("query.n", "integer_id")], query="e=a%40b.co&n=7&n=8&z=1", salt=SALT))
    a(fr_case("hints-resp", [M("resp.email", "email"), M("resp.n", "integer_id")], resp_body='{"email":"a@b.co","n":7,"z":1}', resp_ct=J, salt=SALT, resp_status=200))
    a(fr_case("hints-resp-scoped-mask-carries-type", [M("resp:404.email", "email")], resp_body='{"email":"a@b.co"}', resp_ct=J, salt=SALT, resp_status=404))
    a(fr_case("hints-resp-scoped-mask-type-applies-to-all-statuses", [M("resp:404.email", "email")], resp_body='{"email":"a@b.co"}', resp_ct=J, salt=SALT, resp_status=200))
    a(fr_case("hints-resp-scoped-last-write-wins", [M("resp:404.v", "email"), M("resp:500.v", "uuid")], resp_body='{"v":"x"}', resp_ct=J, salt=SALT, resp_status=404))
    a(fr_case("hints-same-value-referential-integrity", [M("body.a", "email"), M("body.b", "email")], body='{"a":"x@y.co","b":"x@y.co"}', ct=J, salt=SALT))
    a(fr_case("hints-float-int-same-str", [M("body.a", "integer_id"), M("body.b", "decimal_amount")], body='{"a":1.0,"b":1.0}', ct=J, salt=SALT))
    # scalar exact
    PB = '{"user":{"name":"n","age":3,"tags":["a","b"],"addr":{"city":"c"}},"top":"t","arr":[{"id":1,"x":2},{"id":3}],"sc":[1,2]}'
    a(fr_case("exact-keep-parent-does-not-keep-child", [K("body.user")], body=PB, ct=J))
    a(fr_case("exact-keep-child-only", [K("body.user.name")], body=PB, ct=J))
    a(fr_case("exact-keep-child-not-sibling", [K("body.user.addr.city"), K("body.top")], body=PB, ct=J))
    a(fr_case("exact-keep-array-elements", [K("body.arr.[].id"), K("body.sc.[]")], body=PB, ct=J))
    a(fr_case("exact-keep-array-without-brackets-no-effect", [K("body.arr.id"), K("body.sc")], body=PB, ct=J))
    a(fr_case("exact-keep-numeric-index-no-effect", [K("body.arr.0.id"), K("body.sc.0")], body=PB, ct=J))
    a(fr_case("exact-keep-scalar-array-under-object", [K("body.user.tags.[]")], body=PB, ct=J))
    a(fr_case("exact-root-array", [K("body.[].id")], body='[{"id":1,"x":2},{"id":3}]', ct=J))
    a(fr_case("exact-root-scalar-array", [K("body.[]")], body="[1,\"a\",null]", ct=J))
    a(fr_case("exact-root-scalar-no-path", [K("body.")], body="5", ct=J))
    a(fr_case("exact-nested-arrays", [K("body.a.[].[].v")], body='{"a":[[{"v":1,"w":2}],[{"v":3}]]}', ct=J))
    a(fr_case("exact-null-stays-null-even-with-keep", [K("body.n")], body='{"n":null,"m":null}', ct=J))
    a(fr_case("exact-keep-bool-and-number", [K("body.t"), K("body.i"), K("body.f")], body='{"t":true,"i":7,"f":1.5,"u":false,"j":8}', ct=J))
    a(fr_case("exact-keep-float-formats", [K("body.a"), K("body.b"), K("body.c"), K("body.d"), K("body.e")],
              body='{"a":1.0,"b":1e16,"c":1e-7,"d":0.30000000000000004,"e":-0.0}', ct=J))
    a(fr_case("exact-keep-big-int", [K("body.a"), K("body.b")], body='{"a":9223372036854775808,"b":123456789012345678901234567890}', ct=J))
    a(fr_case("exact-keep-nan", [K("body.a")], body='{"a":NaN,"b":Infinity}', ct=J))
    a(fr_case("exact-masked-number-types", [], body='{"a":1,"b":1.5,"c":true,"d":"s","e":null,"f":-0.0}', ct=J))
    a(fr_case("exact-key-with-dot-ambiguity", [K("body.a.b")], body='{"a.b":"x","a":{"b":"y"}}', ct=J))
    a(fr_case("exact-nonascii-keys-escaped", [K("body.café")], body='{"café":"x","\U0001F600":"y"}', ct=J))
    a(fr_case("exact-nonascii-values-kept", [K("body.v")], body='{"v":"café \U0001F600  "}', ct=J))
    a(fr_case("exact-empty-body-stays-empty", [K("body.a")], body="", ct=J, resp_body="", resp_ct=J))
    a(fr_case("exact-whitespace-body-masked", [K("body.a")], body="  ", ct=J))
    a(fr_case("exact-nonjson-body-masked", [K("body.a")], body="hello", ct="text/plain"))
    a(fr_case("exact-json-with-text-plain-ct-parsed", [K("body.a")], body='{"a":"x","b":"y"}', ct="text/plain"))
    a(fr_case("exact-invalid-form-percent", [K("body.a")], body="a=%zz&b=%E9", ct=FORM))
    a(fr_case("form-keep-and-mask", [K("body.a")], body="a=1&a=2&b=3&c=", ct=FORM))
    a(fr_case("form-keep-brackets-key", [K("body.a[]")], body="a[]=1&a[]=2&b=3", ct=FORM))
    a(fr_case("form-keep-blank-and-bare", [K("body.a"), K("body.b")], body="a=&b&c", ct=FORM))
    a(fr_case("form-free-text-kept-key", [K("body.a"), K("body.Dear SECRET")], body="a=1&Dear SECRET", ct=FORM))
    a(fr_case("form-free-text-resp", [K("resp.a")], resp_body="Dear SECRET, your PIN is 1234", resp_ct=FORM, resp_status=200))
    a(fr_case("form-keep-encoded-key", [K("body.a b")], body="a+b=1&c=2", ct=FORM))
    a(fr_case("form-keep-plus-value-roundtrip", [K("body.a")], body="a=x+y%2B%26%3D&b=1", ct=FORM))
    a(fr_case("form-keep-case-sensitive", [K("body.A")], body="a=1&A=2", ct=FORM))
    a(fr_case("form-resp-body", [K("resp.a")], resp_body="a=1&b=2", resp_ct=FORM, resp_status=200))
    a(fr_case("query-keep", [K("query.page")], query="page=2&q=x&page=3&flag&empty=", salt=None))
    a(fr_case("query-keep-case-sensitive", [K("query.Page")], query="page=2&Page=3"))
    a(fr_case("query-keep-special-chars", [K("query.a/b")], query="a%2Fb=x%20y&c=1"))
    a(fr_case("query-empty-stays-empty", [K("query.a")], query=""))
    a(fr_case("query-semicolon-single-key", [K("query.a")], query="a=1;b=2"))
    # header vs resp_header
    a(fr_case("header-keep-does-not-keep-resp-header", [K("header.X-Trace")], headers={"X-Trace": "t", "X-Other": "o"},
              resp_headers={"X-Trace": "t", "X-Other": "o"}))
    a(fr_case("resp-header-keep-does-not-keep-req-header", [K("resp_header.X-Trace")], headers={"X-Trace": "t"}, resp_headers={"X-Trace": "t"}))
    a(fr_case("header-keep-lowercased-matching", [K("header.X-TRACE"), K("resp_header.X-RESP")],
              headers={"x-trace": "t", "X-Trace": "t2"}, resp_headers={"X-Resp": "r", "x-resp": "r2"}))
    a(fr_case("header-allowlist-always-kept", [], headers={"Content-Type": "a", "Authorization": "b", "HOST": "h"},
              resp_headers={"Content-Type": "a", "Set-Cookie": "c", "Transfer-Encoding": "chunked"}))
    a(fr_case("header-keep-value-not-regex-masked", [K("header.x-mail")], headers={"X-Mail": "alice@example.com"}))
    a(fr_case("header-nonstring-values", [K("header.x-n")], headers={"X-N": 5, "X-M": 6}))
    a(fr_case("resp-header-scoped-and-generic-independent", [K("resp_header.a"), K("resp_header:500.b")],
              resp_headers={"A": "1", "B": "2"}, resp_status=500))
    a(fr_case("resp-body-keep-does-not-keep-req-body", [K("resp.a")], body='{"a":1}', ct=J, resp_body='{"a":1}', resp_ct=J))
    a(fr_case("req-body-keep-does-not-keep-resp-body", [K("body.a")], body='{"a":1}', ct=J, resp_body='{"a":1}', resp_ct=J))
    # no built-in patterns: kept strings go out as they are
    a(fr_case("kept-verbatim-email-in-kept-string", [K("body.note")], body='{"note":"mail alice@example.com now","o":"alice@example.com"}', ct=J))
    a(fr_case("kept-verbatim-email-variants", [K("body.a"), K("body.b"), K("body.c"), K("body.d")],
              body='{"a":"x.y+z@sub.EXAMPLE.co","b":"a@b","c":"a@b.c","d":"_@-.aa"}', ct=J))
    a(fr_case("kept-verbatim-card-16-digits", [K("body.a"), K("body.b"), K("body.c"), K("body.d"), K("body.e")],
              body='{"a":"4111111111111111","b":"4111 1111 1111 1111","c":"4111-1111-1111-1111","d":"411111111111111","e":"pay 4111111111111111 ok"}', ct=J))
    a(fr_case("kept-verbatim-card-17-digits", [K("body.a")], body='{"a":"41111111111111111"}', ct=J))
    a(fr_case("kept-verbatim-card-embedded-in-word", [K("body.a"), K("body.b")], body='{"a":"x4111111111111111","b":"4111111111111111x"}', ct=J))
    a(fr_case("kept-verbatim-card-unicode-digits", [K("body.a")], body='{"a":"٤١١١١١١١١١١١١١١١"}', ct=J))
    a(fr_case("kept-verbatim-word-boundary-unicode", [K("body.a"), K("body.b")], body='{"a":"éa@b.co","b":"a@b.coé"}', ct=J))
    a(fr_case("kept-verbatim-not-applied-to-numbers", [K("body.n")], body='{"n":4111111111111111}', ct=J))
    a(fr_case("kept-verbatim-form-and-query", [K("body.a"), K("query.q")], body="a=x%40y.com&b=1", ct=FORM, query="q=4111111111111111&r=2"))
    a(fr_case("kept-verbatim-resp-body", [K("resp.a")], resp_body='{"a":"to a@b.com"}', resp_ct=J))
    a(fr_case("kept-verbatim-multiple-replacements", [K("body.a")], body='{"a":"a@b.com and c@d.org and 4111111111111111"}', ct=J))
    a(fr_case("kept-verbatim-not-applied-to-keys", [K("body.a@b.com")], body='{"a@b.com":"x"}', ct=J))
    # project defaults
    PD = {"field_masks": ["ignored"], "regex_masks": [{"pattern": "secret-\\d+", "replace": "<redacted>", "flags": ""}]}
    a(fr_case("defaults-email-not-masked", [K("body.a"), K("body.b")], body='{"a":"alice@example.com","b":"secret-123"}', ct=J, project_defaults=PD))
    a(fr_case("defaults-custom-regex-flag-i", [K("body.a")], body='{"a":"Token ABC and token abc"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "token \\w+", "replace": "T", "flags": "i"}]}))
    a(fr_case("defaults-custom-regex-no-flag-case-sensitive", [K("body.a")], body='{"a":"Token ABC and token abc"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "token \\w+", "replace": "T", "flags": ""}]}))
    a(fr_case("defaults-flags-contains-i-among-others", [K("body.a")], body='{"a":"ABC abc"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "abc", "replace": "x", "flags": "gi"}]}))
    a(fr_case("defaults-flags-uppercase-I-ignored", [K("body.a")], body='{"a":"ABC abc"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "abc", "replace": "x", "flags": "I"}]}))
    a(fr_case("defaults-empty-replace-becomes-masked", [K("body.a")], body='{"a":"secret-1 here"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "secret-\\d", "replace": "", "flags": ""}]}))
    a(fr_case("defaults-missing-replace-becomes-masked", [K("body.a")], body='{"a":"secret-1 here"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "secret-\\d"}]}))
    a(fr_case("defaults-invalid-pattern-masks-kept-strings", [K("body.a")], body='{"a":"secret-1 and bad("}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "bad(", "replace": "X", "flags": ""}, {"pattern": "secret-\\d", "replace": "S", "flags": ""}]}))
    a(fr_case("defaults-only-invalid-pattern-masks-kept-strings", [K("body.a")], body='{"a":"alice@example.com"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "bad(", "replace": "X", "flags": ""}]}))
    a(fr_case("defaults-repeat-count-too-large-masks-kept-strings", [K("body.a")], body='{"a":"alice@example.com"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "a{4294967295}", "replace": "X", "flags": ""}]}))
    a(fr_case("defaults-repeat-count-at-limit-usable", [K("body.a")], body='{"a":"alice@example.com"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "z{4294967294}", "replace": "X", "flags": ""}]}))
    # malformed entries fail closed: valid rules still apply, every kept string is masked
    MB = '{"password":"hunter2","note":"hello","n":1}'
    MK = [K("body.password"), K("body.note"), K("body.n")]
    for name, pd in [
        ("defaults-malformed-non-string-pattern", {"field_masks": ["password"], "regex_masks": [{"pattern": 5}]}),
        ("defaults-malformed-empty-pattern", {"field_masks": ["password"], "regex_masks": [{"pattern": ""}]}),
        ("defaults-malformed-entry-not-object", {"field_masks": ["password"], "regex_masks": ["x"]}),
        ("defaults-malformed-non-string-replace", {"field_masks": ["password"], "regex_masks": [{"pattern": "zz", "replace": 5}]}),
        ("defaults-malformed-non-string-flags", {"field_masks": ["password"], "regex_masks": [{"pattern": "zz", "flags": 5}]}),
        ("defaults-malformed-non-string-field-mask", {"field_masks": [1, "password"]}),
        ("defaults-malformed-field-masks-not-a-list", {"field_masks": "password"}),
        ("defaults-malformed-regex-masks-not-a-list", {"field_masks": ["password"], "regex_masks": {"pattern": "zz"}}),
    ]:
        a(fr_case(name, MK, body=MB, ct=J, project_defaults=pd))
    a(fr_case("defaults-empty-set-no-patterns", [K("body.a")], body='{"a":"alice@example.com"}', ct=J,
              project_defaults={"field_masks": [], "regex_masks": []}))
    a(fr_case("defaults-field-masks-only", [K("body.a")], body='{"a":"alice@example.com"}', ct=J,
              project_defaults={"field_masks": ["x"], "regex_masks": []}))
    a(fr_case("defaults-regex-order", [K("body.a")], body='{"a":"abc"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "a", "replace": "b", "flags": ""}, {"pattern": "b", "replace": "c", "flags": ""}]}))
    a(fr_case("defaults-replacement-backreference", [K("body.a")], body='{"a":"ab-12"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "([a-z]+)-(\\d+)", "replace": "\\2-\\1", "flags": ""}]}))
    a(fr_case("defaults-named-group-python-syntax", [K("body.a")], body='{"a":"ab-12"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "(?P<w>[a-z]+)-\\d+", "replace": "<\\g<w>>", "flags": ""}]}))
    a(fr_case("defaults-leading-inline-flag", [K("body.a")], body='{"a":"ABC"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "(?i)abc", "replace": "x", "flags": ""}]}))
    a(fr_case("defaults-backslash-Z-anchor", [K("body.a")], body='{"a":"end"}', ct=J,
              project_defaults={"regex_masks": [{"pattern": "end\\Z", "replace": "X", "flags": ""}]}))
    a(fr_case("defaults-applies-to-query-form-resp", [K("body.a"), K("query.q"), K("resp.r")], body="a=secret-1", ct=FORM, query="q=secret-2",
              resp_body='{"r":"secret-3"}', resp_ct=J, project_defaults=PD))
    a(fr_case("defaults-email-domain-custom-with-hint", [M("body.e", "email"), K("body.k")], body='{"e":"a@b.co","k":"x@example.invalid"}', ct=J,
              salt=SALT, email_domain="example.invalid"))
    a(fr_case("defaults-email-domain-empty-string-falls-back", [M("body.e", "email")], body='{"e":"a@b.co"}', ct=J, salt=SALT, email_domain=""))
    a(fr_case("defaults-regex-masks-generated-email", [M("body.e", "email")], body='{"e":"a@b.co"}', ct=J, salt=SALT, project_defaults=PD))
    emit("field-rules-extra.json",
         "Additional field-rule cases. Same shape as field-rules-vectors but expected values are exact strings: masked_body, "
         "masked_query and masked_resp_body are the literal output of apply_field_rules / apply_resp_field_rules (Python json.dumps "
         "text with default separators and ensure_ascii; urlencode(doseq=True) text). input.salt is STUBSMITH_MASK_SALT (null "
         "means unset). input.project_defaults mirrors the sync project_defaults object (null means none synced; a defaults object "
         "that compiles to no rules is the same as none). email_domain null means the module default.",
         "stubsmith.privacy.field_rules.compile_field_rules, apply_field_rules, apply_resp_field_rules; masking.compile_rules", c)


# ---------------------------------------------------------------------------
# 9. payload
# ---------------------------------------------------------------------------
class StubCache(RulesCache):
    def __init__(self, responses):
        super().__init__(api_key="sk-test", backend_url="http://fake")
        self._fake = responses

    def _http_get(self, url):
        for frag, res in self._fake.items():
            if frag in url:
                return res
        return (0, None)


def sync_body(rules=None, templates=None, defaults=None, value_config=None, cursor="1"):
    b = {"ok": True, "cursor": cursor, "rules": rules or [], "path_templates": templates or []}
    if defaults is not None:
        b["project_defaults"] = defaults
    if value_config is not None:
        b["request_type_value_config"] = value_config
    return b


def run_pipeline(state, req, salt=None):
    """state: {"kind": "none"|"sync", "sync": body}"""
    kind = state["kind"]
    if kind == "none":
        cache = StubCache({})
    elif kind == "sync":
        cache = StubCache({"/v1/sdk/sync": (200, state["sync"])})
        cache._poll_once()
    else:
        raise ValueError(kind)
    pipe = PrivacyPipeline(rules_cache=cache)
    with env_salt(salt):
        return pipe.process(req["method"], req["url"], req["req_headers"], req["req_body"], req["resp_status"],
                            req["resp_headers"], req["resp_body"])


def gen_payload():
    JH = {"Content-Type": "application/json"}
    scen = {}
    scen["json-post"] = dict(
        method="post", url="https://api.example.com/v1/orders?page=2&email=alice%40example.com&page=3",
        req_headers={"Content-Type": "application/json", "Authorization": "Bearer dummy-token", "X-Req-Id": "r-1", "Accept": "application/json"},
        req_body='{"user":{"email":"alice@example.com","name":"Alice"},"amount":99,"items":[{"sku":"a1","qty":1},{"sku":"b2","qty":2}],"paid":true,"note":null}',
        resp_status=201, resp_headers={"Content-Type": "application/json; charset=utf-8", "X-Trace": "t-9", "Set-Cookie": "s=1"},
        resp_body='{"id":"ord-7","status":"ok","owner":"alice@example.com","total":99.5}')
    scen["get-nobody"] = dict(
        method="GET", url="https://api.example.com/v1/orders/123456?expand=items", req_headers={"Accept": "application/json", "X-Req-Id": "r-2"}, req_body="",
        resp_status=200, resp_headers=JH, resp_body='{"id":123456,"items":[{"sku":"a1"}],"ref":"550e8400-e29b-41d4-a716-446655440000"}')
    scen["form-post"] = dict(
        method="POST", url="https://api.example.com/login", req_headers={"content-type": "application/x-www-form-urlencoded; charset=UTF-8", "Cookie": "a=b"},
        req_body="user=bob%40example.com&pw=p+w%21&user=al&flag&empty=", resp_status=200, resp_headers=JH, resp_body='{"token":"dummy","ok":true}')
    scen["image-resp"] = dict(
        method="GET", url="https://cdn.example.com/avatar/42.png", req_headers={"Accept": "image/*"}, req_body="",
        resp_status=200, resp_headers={"Content-Type": "image/png"}, resp_body="\u0089PNG-raw-bytes-not-real")
    scen["image-req-gif"] = dict(
        method="PUT", url="https://cdn.example.com/upload", req_headers={"Content-Type": "IMAGE/GIF"}, req_body="GIF89a-raw",
        resp_status=200, resp_headers={"Content-Type": "image/jpeg"}, resp_body="jpegbytes")
    scen["text-resp"] = dict(
        method="GET", url="https://api.example.com/health", req_headers={}, req_body="", resp_status=200,
        resp_headers={"Content-Type": "text/plain"}, resp_body="OK contact alice@example.com")
    scen["error-404"] = dict(
        method="POST", url="https://api.example.com/v1/orders", req_headers=JH, req_body='{"amount":5}',
        resp_status=404, resp_headers={"Content-Type": "application/json", "X-Err": "e1"},
        resp_body='{"error":"not_found","detail":"order alice@example.com missing","code":404,"id":"zz"}')
    scen["host-port-userinfo"] = dict(
        method="get", url="https://user:pw@api.example.com:8443/v1/things/9?x=1&y=", req_headers={"Accept": "*/*"}, req_body="",
        resp_status=200, resp_headers=JH, resp_body='{"thing":"t","n":1}')
    scen["userinfo-password"] = dict(
        method="POST", url="http://usr:SECRET_PW@api.example.com/v1/notes", req_headers={"Content-Type": FORM},
        req_body="Dear SECRET, your PIN is 1234", resp_status=200, resp_headers=JH, resp_body='{"ok":true}')
    scen["no-query-trailing-slash"] = dict(
        method="DELETE", url="http://localhost:3000/v1/things/", req_headers={}, req_body="", resp_status=204, resp_headers={}, resp_body="")
    scen["fragment-and-params"] = dict(
        method="GET", url="https://api.example.com/v1/a;p=1/b?q=1#frag", req_headers={}, req_body="", resp_status=200, resp_headers=JH, resp_body="[1,2]")

    # per-scenario known rules
    rules = {
        "json-post": [K for K in [
            {"path": "body.amount", "action": "keep"}, {"path": "body.items.[].qty", "action": "keep"},
            {"path": "body.user.email", "action": "mask", "type": "email"}, {"path": "query.page", "action": "keep"},
            {"path": "header.x-req-id", "action": "keep"}, {"path": "resp.status", "action": "keep"},
            {"path": "resp.owner", "action": "keep"}, {"path": "resp_header.x-trace", "action": "keep"},
            {"path": "resp.id", "action": "mask", "type": "opaque_token"}]],
        "get-nobody": [{"path": "query.expand", "action": "keep"}, {"path": "resp.items.[].sku", "action": "keep"},
                       {"path": "resp.id", "action": "mask", "type": "integer_id"}],
        "form-post": [{"path": "body.flag", "action": "keep"}, {"path": "body.user", "action": "keep"},
                      {"path": "body.pw", "action": "mask", "type": "free_text"}, {"path": "resp.ok", "action": "keep"}],
        "image-resp": [{"path": "resp.x", "action": "keep"}],
        "image-req-gif": [],
        "text-resp": [{"path": "resp.x", "action": "keep"}],
        "error-404": [{"path": "body.amount", "action": "keep"}, {"path": "resp.code", "action": "keep"},
                      {"path": "resp.detail", "action": "keep"}, {"path": "resp:404.error", "action": "keep"},
                      {"path": "resp:404.detail", "action": "mask"}, {"path": "resp:404.id", "action": "mask", "type": "uuid"},
                      {"path": "resp:99.code", "action": "keep"}, {"path": "resp_header:404.x-err", "action": "keep"}],
        "host-port-userinfo": [{"path": "query.x", "action": "keep"}, {"path": "resp.n", "action": "keep"}],
        "userinfo-password": [{"path": "body.Dear SECRET, your PIN is 1234", "action": "keep"}, {"path": "resp.ok", "action": "keep"}],
        "no-query-trailing-slash": [],
        "fragment-and-params": [{"path": "resp.[]", "action": "keep"}],
    }
    templates = ["/v1/orders/{id}", "/v1/things/{id}"]
    PD = {"field_masks": ["ignored"], "email_placeholder_domain": "example.invalid",
          "regex_masks": [{"pattern": "secret-\\d+", "replace": "", "flags": "i"}, {"pattern": "bad(", "replace": "x", "flags": ""}]}
    VALUE_PATHS = {"json-post": ["amount", "paid", "user.name", "note", "missing"], "form-post": ["user", "flag", "empty"],
                   "error-404": ["amount"]}

    c = []
    for sname, req in scen.items():
        def add(stname, state, salt=None):
            out = run_pipeline(state, req, salt)
            c.append({"name": f"{sname}/{stname}", "input": {"state": state, "salt": salt, "request": req},
                      "expected": {"payload": out}})

        add("no-sync", {"kind": "none"})
        add("sync-miss-novel", {"kind": "sync", "sync": sync_body(templates=templates, cursor="5")})
        # discover endpoint id + fp with the same state shape used for the known state
        def known(extra_defaults=None, value_config=None, rule_list=None, cursor="12"):
            probe = sync_body(templates=templates, value_config=value_config)
            p = run_pipeline({"kind": "sync", "sync": probe}, req)
            domain = urllib.parse.urlparse(req["url"]).netloc
            rt = {"domain": domain, "method": req["method"].upper(), "path_template": p["path_template"]}
            body = sync_body(rules=[{"seq": 1, "request_type": rt, "fingerprint": p["req_fingerprint"],
                                     "field_rules": rule_list if rule_list is not None else rules[sname]}],
                             templates=templates, defaults=extra_defaults, value_config=value_config, cursor=cursor)
            return {"kind": "sync", "sync": body}, f"{domain}|{req['method'].upper()}|{p['path_template']}"

        st, eid = known()
        add("field-rules-known", st)
        add("field-rules-known-salt", st, "test-salt-123")
        st, _ = known(extra_defaults=PD)
        add("project-defaults-email-domain-salt", st, "test-salt-123")
        add("project-defaults-no-salt", st)
        st, _ = known(extra_defaults={"email_placeholder_domain": "example.invalid"})
        add("email-domain-only-no-patterns", st, "test-salt-123")
        if sname in VALUE_PATHS:
            st, eid = known(value_config={eid_key: VALUE_PATHS[sname] for eid_key in [known()[1]]})
            add("value-config", st)
            # value config present but rules keyed on the base fingerprint: miss -> novel
            vc = {eid: VALUE_PATHS[sname]}
            add("value-config-fingerprint-mismatch-novel", {"kind": "sync", "sync": sync_body(
                rules=st["sync"]["rules"], templates=templates, value_config={eid: ["nonexistent"]})})
        # Project field masks win over keep rules: names listed here are kept by rules[sname] in several scenarios.
        st, _ = known(extra_defaults={"field_masks": ["Email", "amount", "x-trace", "code", "X-Err", "x", "user"],
                                      "regex_masks": []})
        add("project-field-masks-override-keep", st)
    # extra: fail-closed on masking exception is not reproducible from inputs; skipped. Invalid url -> still parses.
    c.append({"name": "relative-url-no-host/no-sync", "input": {"state": {"kind": "none"}, "salt": None, "request": {
        "method": "get", "url": "/just/a/path?x=1", "req_headers": {}, "req_body": "", "resp_status": 200, "resp_headers": {}, "resp_body": ""}},
        "expected": {"payload": run_pipeline({"kind": "none"}, {"method": "get", "url": "/just/a/path?x=1", "req_headers": {}, "req_body": "",
                                                                  "resp_status": 200, "resp_headers": {}, "resp_body": ""})}})
    emit("payload.json",
         "Full PrivacyPipeline.process runs. input.state.kind: none (no sync, fresh cache), sync (input.state.sync is a "
         "/v1/sdk/sync response body fed through the cache merge). A 404 from sync leaves the cache as it was, which "
         "for a fresh cache is the none state. input.salt is STUBSMITH_MASK_SALT or null. expected.payload is the exact dict from process() "
         "(sdk_version is the SDK constant; duration and source are added later by the client). Body strings are Python json.dumps "
         "text. Not covered: the masking-exception degradation path (cannot be triggered from data).",
         "stubsmith.privacy.pipeline.PrivacyPipeline.process via a RulesCache whose _http_get is stubbed", c)


# ---------------------------------------------------------------------------
# 10. refusals
# ---------------------------------------------------------------------------
class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append({"level": record.levelname, "message": record.getMessage()})


def run_calls(calls):
    sdk_client._reset_ingest_warnings()
    h = _ListHandler()
    lg = logging.getLogger("stubsmith")
    old_level, old_prop = lg.level, lg.propagate
    lg.addHandler(h)
    lg.setLevel(logging.DEBUG)
    lg.propagate = False
    try:
        for call in calls:
            raw = call["raw"]
            if isinstance(raw, dict) and "bytes_hex" in raw:
                raw = bytes.fromhex(raw["bytes_hex"])
            elif isinstance(raw, dict) and raw.get("none"):
                raw = None
            sdk_client._report_ingest_refusal(raw, call.get("status"), call.get("debug", False))
    finally:
        lg.removeHandler(h)
        lg.setLevel(old_level)
        lg.propagate = old_prop
        sdk_client._reset_ingest_warnings()
    return h.records


def gen_refusals():
    c = []

    def one(name, raw, status=200, debug=False):
        calls = [{"raw": raw, "status": status, "debug": debug}]
        c.append({"name": name, "input": {"calls": calls}, "expected": {"logs": run_calls(calls)}})

    def seq(name, calls):
        c.append({"name": name, "input": {"calls": calls}, "expected": {"logs": run_calls(calls)}})

    j = json.dumps
    one("stored-201", j({"ok": True, "id": "abc"}), 201)
    one("pending-202", j({"ok": True, "pending": True, "id": "x"}), 202)
    one("body-too-large-202-ok-true", j({"ok": True, "stored": False, "error": "body_too_large"}), 202)
    one("fingerprint-limit-200", j({"ok": False, "error": "fingerprint_limit_reached"}), 200)
    one("pii-leak", j({"ok": False, "error": "pii_leak"}), 422)
    one("rejected-true-422", j({"ok": False, "rejected": True}), 422)
    one("rejected-true-with-reason", j({"ok": False, "rejected": True, "reason": "dashboard_reject"}), 422)
    one("malformed-payload-400", j({"ok": False, "error": "malformed_payload"}), 400)
    one("read-failed-400", j({"ok": False, "error": "read_failed"}), 400)
    one("sdk-required-400", j({"ok": False, "error": "sdk_required"}), 400)
    one("payload-too-large-413", j({"ok": False, "error": "payload_too_large"}), 413)
    one("body-too-large-ok-false", j({"ok": False, "error": "body_too_large"}), 202)
    one("rate-limit-429", j({"ok": False, "error": "rate limit exceeded"}), 429)
    one("ok-false-reason-only", j({"ok": False, "reason": "some_reason"}), 400)
    one("ok-false-error-and-reason", j({"ok": False, "error": "e", "reason": "r"}), 400)
    one("ok-false-nothing", j({"ok": False}), 500)
    one("ok-false-empty-error-falls-to-reason", j({"ok": False, "error": "", "reason": "r"}), 400)
    one("ok-false-empty-error-rejected", j({"ok": False, "error": "", "rejected": True}), 400)
    one("ok-false-rejected-false", j({"ok": False, "rejected": False}), 400)
    one("ok-false-rejected-truthy-string", j({"ok": False, "rejected": "yes"}), 400)
    one("ok-false-rejected-zero", j({"ok": False, "rejected": 0}), 400)
    one("ok-false-error-number", j({"ok": False, "error": 42}), 400)
    one("ok-false-error-object", j({"ok": False, "error": {"a": 1}}), 400)
    one("ok-false-error-true", j({"ok": False, "error": True}), 400)
    one("ok-false-error-list-empty-falsy", j({"ok": False, "error": [], "reason": "r"}), 400)
    one("ok-false-error-80-chars", j({"ok": False, "error": "e" * 80}), 400)
    one("ok-false-error-81-chars", j({"ok": False, "error": "e" * 81}), 400)
    one("ok-false-error-200-chars", j({"ok": False, "error": "x" * 200}), 400)
    one("ok-false-error-nonascii-truncated", j({"ok": False, "error": "\U0001F600" * 100}), 400)
    one("ok-false-error-80-then-remedy-lookup", j({"ok": False, "error": "pii_leak" + " " * 80}), 400)
    one("ok-false-with-message", j({"ok": False, "error": "x", "message": "Something went wrong"}), 400)
    one("ok-false-message-ends-with-period", j({"ok": False, "error": "x", "message": "Done."}), 400)
    one("ok-false-message-ends-with-question", j({"ok": False, "error": "x", "message": "Why?"}), 400)
    one("ok-false-message-ends-with-bang", j({"ok": False, "error": "x", "message": "No!"}), 400)
    one("ok-false-message-whitespace-padded", j({"ok": False, "error": "x", "message": "  padded  "}), 400)
    one("ok-false-message-whitespace-only", j({"ok": False, "error": "x", "message": "   "}), 400)
    one("ok-false-message-250-chars", j({"ok": False, "error": "x", "message": "m" * 250}), 400)
    one("ok-false-message-not-string", j({"ok": False, "error": "x", "message": 5}), 400)
    one("ok-false-known-code-with-message", j({"ok": False, "error": "pii_leak", "message": "A value matched"}), 422)
    one("ok-true-with-error", j({"ok": True, "error": "x"}), 200)
    one("ok-missing", j({"error": "x"}), 400)
    one("ok-null", j({"ok": None, "error": "x"}), 400)
    one("ok-zero", j({"ok": 0, "error": "x"}), 400)
    one("ok-string-false", j({"ok": "false", "error": "x"}), 400)
    one("json-array", j([{"ok": False, "error": "x"}]), 400)
    one("json-string", j("nope"), 400)
    one("json-null", "null", 400)
    one("non-json-text", "Unauthorized", 401)
    one("non-json-500", "Internal Server Error", 500)
    one("html-body", "<html><body>bad gateway</body></html>", 502)
    one("empty-body", "", 500)
    one("whitespace-body", "   \n", 500)
    one("truncated-json", '{"ok": false, "error": "x"', 400)
    one("json-with-bom", "﻿" + j({"ok": False, "error": "bom"}), 400)
    one("json-with-surrounding-whitespace", "  " + j({"ok": False, "error": "ws"}) + "\n", 400)
    one("bytes-body", {"bytes_hex": j({"ok": False, "error": "from_bytes"}).encode().hex()}, 400)
    one("bytes-body-invalid-utf8-replaced", {"bytes_hex": (b'{"ok": false, "error": "bad\xff"}').hex()}, 400)
    one("bytes-body-nonascii", {"bytes_hex": j({"ok": False, "error": "café"}, ensure_ascii=False).encode("utf-8").hex()}, 400)
    one("raw-none", {"none": True}, 400)
    one("status-none", j({"ok": False, "error": "x"}), None)
    one("status-string", j({"ok": False, "error": "x"}), "400")
    one("status-bool", j({"ok": False, "error": "x"}), True)
    one("status-zero", j({"ok": False, "error": "x"}), 0)
    one("debug-logs-full-body", j({"ok": False, "error": "fingerprint_limit_reached"}), 200, True)
    one("debug-long-body-truncated-2048", j({"ok": False, "error": "e", "pad": "p" * 3000}), 400, True)
    one("debug-non-refusal-silent", j({"ok": True}), 200, True)
    one("debug-non-json-silent", "oops", 500, True)
    one("debug-nonascii-body", j({"ok": False, "error": "x", "m": "\U0001F600" * 1500}, ensure_ascii=False), 400, True)
    one("body-over-64k-not-truncated-here", j({"ok": False, "error": "x", "pad": "p" * 70000}), 400)
    seq("dedupe-same-code-twice", [{"raw": j({"ok": False, "error": "x"}), "status": 400}] * 2)
    seq("dedupe-different-status-same-code", [{"raw": j({"ok": False, "error": "x"}), "status": 400},
                                              {"raw": j({"ok": False, "error": "x"}), "status": 500}])
    seq("dedupe-by-truncated-code", [{"raw": j({"ok": False, "error": "e" * 80 + "A"}), "status": 400},
                                     {"raw": j({"ok": False, "error": "e" * 80 + "B"}), "status": 400}])
    seq("dedupe-debug-logs-every-time", [{"raw": j({"ok": False, "error": "x"}), "status": 400, "debug": True}] * 2)
    seq("dedupe-rejected-vs-explicit-rejected-error", [{"raw": j({"ok": False, "rejected": True}), "status": 422},
                                                       {"raw": j({"ok": False, "error": "rejected"}), "status": 422}])
    seq("dedupe-unknown-code", [{"raw": j({"ok": False}), "status": 400}, {"raw": j({"ok": False, "error": "unknown"}), "status": 400}])
    seq("cap-64-codes", [{"raw": j({"ok": False, "error": f"code_{i:03d}"}), "status": 400} for i in range(66)]
        + [{"raw": j({"ok": False, "error": "code_000"}), "status": 400}])
    emit("refusals.json",
         "Ingest refusal reporting. Each case replays input.calls (raw is a text body, or {bytes_hex} for bytes, or {none:true}; "
         "status; debug) against a fresh warned-codes set and records every log record the SDK emits (level + formatted message). "
         "Warn once per code, at most 64 distinct codes.",
         "stubsmith.client._report_ingest_refusal", c)


# ---------------------------------------------------------------------------
# 11. pyfloat
# ---------------------------------------------------------------------------
def gen_pyfloat():
    vals = [
        ("float-1.0", 1.0), ("float-1.5", 1.5), ("float-0.1", 0.1), ("float-0.1p0.2", 0.1 + 0.2), ("float-1e16", 1e16),
        ("float-1e15", 1e15), ("float-123456789012345680000", 123456789012345680000.0), ("float-1e-7", 1e-7),
        ("float-5e-324", 5e-324), ("float-max", 1.7976931348623157e308), ("float-neg-zero", -0.0),
        ("float-1e22", 1e22), ("float-1e21", 1e21), ("float-1e-4", 1e-4), ("float-1e-5", 1e-5), ("float-0.0001234", 0.0001234),
        ("float-1.5e300", 1.5e300), ("float-2pow53", float(2 ** 53)), ("float-9007199254740993", 9007199254740993.0),
        ("float-100.0", 100.0), ("float-neg-1.5", -1.5), ("float-3.14159", 3.14159), ("float-1e100", 1e100),
        ("float-123456.789", 123456.789), ("float-0.5", 0.5), ("float-12345678901234567.0", 12345678901234567.0),
        ("float-1e-323", 1e-323), ("float-2.2250738585072014e-308", 2.2250738585072014e-308),
        ("int-0", 0), ("int-1", 1), ("int-neg", -42), ("int-2pow53", 2 ** 53), ("int-2pow53p1", 2 ** 53 + 1),
        ("int-2pow63", 2 ** 63), ("int-2pow64", 2 ** 64), ("int-10pow20", 10 ** 20), ("int-neg-2pow63", -(2 ** 63)),
        ("int-10pow30", 10 ** 30), ("bool-true", True), ("bool-false", False), ("none", None),
        ("str-x", "x"), ("str-empty", ""), ("str-unicode", "café \U0001F600"), ("str-quote", 'a"b\\c\n'),
        ("str-control", "\u0001\u007f "),
    ]
    c = []
    for n, v in vals:
        c.append({"name": n, "input": {"value": typed(v)}, "expected": {"json_dumps": json.dumps(v), "str": str(v), "repr": repr(v)}})
    for n, v in [("nan", float("nan")), ("inf", float("inf")), ("neg-inf", float("-inf"))]:
        c.append({"name": "float-" + n, "input": {"value": {"type": "float", "text": repr(v)}},
                  "expected": {"json_dumps": json.dumps(v), "str": str(v), "repr": repr(v)}})
    emit("pyfloat.json",
         "Python json.dumps(value) and str(value) output (str() feeds placeholder hashing; json.dumps feeds canonical value pairs "
         "and masked bodies). input.value uses the typed encoding; float/int text is Python repr / decimal digits.",
         "json.dumps, str, repr", c)


# ---------------------------------------------------------------------------
# 12. pyqs
# ---------------------------------------------------------------------------
def gen_pyqs():
    qs = [
        ("empty", ""), ("simple", "a=1&b=2"), ("plus", "a=b+c"), ("percent-2B", "a=%2B"), ("percent-20", "a=%20"),
        ("plus-and-2B-and-20", "a=b+c%2Bd%20e"), ("special-chars-literal", "a=!*'()~"), ("special-chars-encoded", "a=%21%2A%27%28%29%7E"),
        ("slash-literal", "a=/"), ("slash-encoded", "a=%2F"), ("equals-in-value", "a=b=c"), ("equals-multiple", "a==b"),
        ("equals-only", "="), ("equals-key-empty", "=v"), ("double-ampersand", "a=1&&b=2"), ("only-ampersands", "&&"),
        ("trailing-ampersand", "a=1&"), ("leading-ampersand", "&a=1"), ("bare-key", "flag"), ("bare-keys-multiple", "x&y&x"),
        ("blank-value", "a="), ("blank-and-bare", "a=&b&c=1"), ("unicode-raw", "café=日本"),
        ("unicode-encoded", "caf%C3%A9=%E6%97%A5%E6%9C%AC"), ("astral-raw", "k=\U0001F600"), ("astral-encoded", "k=%F0%9F%98%80"),
        ("keys-brackets", "a[]=1&a[]=2&b[x]=3"), ("keys-brackets-encoded", "a%5B%5D=1"), ("repeated-keys", "a=1&a=2&a=3&b=4&a=5"),
        ("repeated-keys-interleaved", "b=1&a=1&b=2&a=2"), ("semicolon", "a=1;b=2"), ("semicolon-in-value", "a=1;b=2&c=3"),
        ("semicolon-encoded", "a=%3B"), ("ampersand-encoded", "a=%26&b=2"), ("percent-lowercase-hex", "a=%e2%82%ac"),
        ("percent-invalid-seq", "a=%zz"), ("percent-truncated", "a=%4"), ("percent-lone", "a=%"), ("invalid-utf8", "a=%E9"),
        ("invalid-utf8-key", "%E9=1"), ("percent-nul", "a=%00"), ("percent-newline", "a=%0A%0D"), ("raw-space", "a=b c"),
        ("raw-tab", "a=b\tc"), ("leading-question-mark", "?a=1"), ("hash-fragment-like", "a=1#b"), ("dup-blank-then-value", "a=&a=1"),
        ("same-key-different-case", "a=1&A=2"), ("space-key", "a+b=1"), ("percent-key-plus", "a%2Bb=1"),
        ("tilde-dot-dash-underscore", "a=~.-_"), ("tilde-encoded", "a=%7E"), ("dollar-comma-colon-at", "a=$,:@"), ("long-value", "a=" + "x" * 300),
        ("many-keys", "&".join(f"k{i}=v{i}" for i in range(12))), ("numeric-keys-order", "b=1&2=1&1=1"),
        ("empty-key-with-value", "=1&=2"), ("key-with-equals-encoded", "a%3Db=c"), ("value-with-percent-literal", "a=100%25"),
        ("crlf-inside", "a=1\r\nb=2"), ("fullwidth-chars", "a=ＡＢ"), ("combining", "a=é"),
    ]
    c = []
    for n, q in qs:
        parsed = urllib.parse.parse_qs(q, keep_blank_values=True)
        pairs = [[k, v] for k, v in parsed.items()]
        masked = {k: ["<masked>"] * len(v) for k, v in parsed.items()}
        c.append({"name": n, "input": {"query": q}, "expected": {
            "parse_qs": pairs, "keys": list(parsed.keys()),
            "urlencode_doseq": urllib.parse.urlencode(parsed, doseq=True),
            "urlencode_doseq_masked": urllib.parse.urlencode(masked, doseq=True),
            "parse_qs_drop_blank": [[k, v] for k, v in urllib.parse.parse_qs(q).items()]}})
    # urlencode-only cases for tricky keys/values (inputs given as explicit pairs)
    enc = [
        ("enc-space-plus", {"a b": ["c d"]}), ("enc-plus", {"a+b": ["c+d"]}), ("enc-special", {"k": ["!*'()~"]}),
        ("enc-unreserved", {"k": ["a-._~"]}), ("enc-slash-eq-amp", {"k/=&": ["/=&"]}), ("enc-unicode", {"café": ["日本", "\U0001F600"]}),
        ("enc-empty", {"a": [""]}), ("enc-empty-list", {"a": []}), ("enc-brackets", {"a[]": ["1", "2"]}),
        ("enc-masked-literal", {"a": ["<masked>"]}), ("enc-percent", {"a": ["100%"]}), ("enc-newline", {"a": ["x\ny\r\n"]}),
        ("enc-dollar-comma-colon-at-semicolon", {"a": ["$,:@;"]}), ("enc-multi-key-order", {"z": ["1"], "a": ["2", "3"], "m": ["4"]}),
    ]
    for n, d in enc:
        c.append({"name": n, "input": {"pairs": [[k, v] for k, v in d.items()]},
                  "expected": {"urlencode_doseq": urllib.parse.urlencode(d, doseq=True)}})
    emit("pyqs.json",
         "urllib.parse.parse_qs(keep_blank_values=True) (ordered [key, values] pairs; dict insertion order = first occurrence) and "
         "urlencode(doseq=True) of the parsed result (quote_plus: space becomes +, safe set is letters digits _.-~). "
         "Cases with input.pairs exercise urlencode only. parse_qs_drop_blank is parse_qs without keep_blank_values for contrast.",
         "urllib.parse.parse_qs, urllib.parse.urlencode", c)


def write_version():
    # The Python SDK version plus a SHA-256 of every vector file, and no commit
    # id. test/conformance-version.test.ts
    # recomputes the digests, so a vector edited by hand fails CI.
    lines = [f"python_sdk_version: {__version__}", "vectors_sha256:"]
    for f in sorted((ROOT / "conformance" / "vectors").glob("*.json"), key=lambda p: p.name):
        lines.append(f"  {f.name}: {hashlib.sha256(f.read_bytes()).hexdigest()}")
    (ROOT / "conformance" / "VECTORS_VERSION").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    gen_blake2b()
    gen_fingerprint()
    gen_templating()
    gen_classify()
    gen_placeholders()
    gen_mask_all()
    copy_field_rules_vectors()
    copy_shared_vectors()
    gen_field_rules_extra()
    gen_payload()
    gen_refusals()
    gen_pyfloat()
    gen_pyqs()
    write_version()
    for k in sorted(COUNTS):
        print(f"{k}: {COUNTS[k]}")


if __name__ == "__main__":
    main()
