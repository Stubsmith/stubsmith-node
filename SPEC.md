# Stubsmith SDK wire contract and algorithms (Node port reference)

Derived from the Python SDK 0.8.0 (Stubsmith/stubsmith-python), which is the
reference wherever this document is silent. File and line references below
point into its `stubsmith/` package and may drift between releases. The Node
SDK must produce byte-identical fingerprints, masked bodies and ingest
payloads for the same inputs.

## 1. Wire contract

### 1.1 POST ingest, default `https://ingest.stubsmith.dev/v1/captures`

One capture per POST, no batching, sent from a background sender.

Headers: `Content-Type: application/json`, `Authorization: Bearer <key>`,
`User-Agent: stubsmith-node/<version>`, and `Content-Encoding: gzip` only when
the body is at least 1024 bytes and gzip level 6 produces fewer bytes.
Timeout 5 s. Body is the JSON payload, UTF-8.

Payload keys (pipeline.py:240-275, client.py:918-919, 693-701):

- always: `sdk_version` (string), `sdk_masked` (true), `sdk_rule_version`
  (sync cursor as string, default `"0"`), `domain` (URL host including port:
  Python `urlparse().netloc` after the last `@`, so userinfo is never sent),
  `path_template`, `path` (path_template plus `?` plus the masked query when
  there is a query, otherwise just path_template), `method` (upper case),
  `status` (int), `req_fingerprint` (16 hex), `resp_fingerprint`
  (`String(status)` + 16 hex), `key_paths` and `resp_key_paths` (walk
  order, not sorted), `req_header_names` and `resp_header_names`
  (lower-cased, sorted), `query_names` (first-occurrence order), `headers`,
  `req_body`, `resp_headers`, `resp_body` (masked), `novel` (bool),
  `source` (string, `node-http` or `node-fetch`), `duration` (int ms),
  `classifier_spec_version` (integer, the spec version of the value-type
  labels in `req_value_types` and `resp_value_types`).
- only when present or non-empty: `req_body_encoding`, `resp_body_encoding`
  (`"base64"`), `fingerprint_value_paths` (array), `req_value_types`,
  `resp_value_types` (object path to label).
- oversize path (serialised payload above 10 MiB): `req_body: null`,
  `resp_body: null`, `bodies_omitted: true`,
  `omitted_reason: "payload_too_large"`, `omitted_req_body_bytes`,
  `omitted_resp_body_bytes`. Warn once per `METHOD path_template`.

Ingest responses and SDK reaction (client.py:53-76, 101-168, 958-1059):

- Every error is swallowed. A send failure increments a counter; `flush`
  stops waiting once a new failure happened.
- Refusal reporting: parse the response body (2xx or error, first 64 KiB)
  as JSON; act only when it is an object with `ok === false`. Code =
  `error`, else `reason`, else `"rejected"` when `rejected` is truthy, else
  `"unknown"`, truncated to 80 chars. Warn once per process per code, cap 64
  codes. Remedy table keys: `fingerprint_limit_reached`, `pii_leak`,
  `rejected`, `body_too_large`, `sdk_required`, `rate limit exceeded`; any
  other code gets a default remedy. Copy the remedy strings from
  client.py:53-76. Debug mode also logs the first 2048 chars of the body.
- Status codes seen from ingest: 201 `{ok:true,id}` stored; 202
  `{ok:true,pending:true,...}` pending review; 202
  `{ok:true,stored:false,error:"body_too_large"}`; 200
  `{ok:false,error:"fingerprint_limit_reached"}`; 422
  `{ok:false,rejected:true}`; 400 `{ok:false,error:"malformed_payload"|
  "read_failed"|"sdk_required"}`; 413 `{ok:false,error:"payload_too_large"}`;
  429 `{ok:false,error:"rate limit exceeded"}`; 401 plain text; 500 plain
  text.

### 1.2 GET `{backendUrl}/v1/sdk/sync?cursor=<cursor>`, default backend `https://app.stubsmith.dev/api`

Headers: `Authorization: Bearer <key>`, `User-Agent: stubsmith-node/<v>`.
Timeout 10 s.

Response:

```
{ ok: true, cursor: "<seq>",
  rules: [{ seq, request_type: { domain, method, path_template }, fingerprint,
            field_rules: [{ path, action, type? }] }],
  path_templates: [string],
  project_defaults: { field_masks: [string],
                      regex_masks: [{ pattern, replace, flags }],
                      email_placeholder_domain: string },
  request_type_value_config: { "domain|METHOD|tmpl": [paths] },
  project_settings: { group_ids_in_paths: boolean } }
```

Merge (rules_cache.py:352-448): rules are additive, keyed by
`(endpoint_id, fingerprint)` where `endpoint_id = domain|METHOD|path_template`
from `request_type`; entries with an empty fingerprint are skipped. Cursor is
updated only when the response cursor is not `"0"`. `path_templates` is a
full replacement. `project_defaults` is stored only when non-empty after
compile; malformed data is ignored. `email_placeholder_domain` overrides only
when it is a non-empty string; default `stub.invalid`. `request_type_value_config`
is a full replacement when it is an object. `project_settings.group_ids_in_paths`
is the "Group IDs in paths automatically" setting; when it is absent or not a
boolean the SDK keeps its current value, and the default is true. When it is
false, `path_template` is the path as written, except where a curated template
applies. The first successful sync marks `firstSyncDone`.

Poll loop (rules_cache.py:313-350): sync immediately, then every
`rulesPollInterval` (60 s). Network error keeps the cache. 404 does NOT fall
back to `GET /v1/anonymizer/rules` (the Python legacy mode is removed here):
the cache is left as it is, the first sync is not marked done, and one warning
per poller names HTTP 404, the sync URL and the backend URL. Any other non-200 or non-object
response keeps the cache. A sync that keeps failing keeps the last good
rules; lookups miss, so everything masks.

### 1.3 GET `{apiUrl}/v1/replay/bundle[?method=&path=&samples=]` (cli.py:74-157)

Headers `Authorization: Bearer`, `User-Agent: stubsmith-cli/<v>`, timeout
30 s. Base URL is `STUBSMITH_API_URL`, else `STUBSMITH_BACKEND_URL`, else
the hosted default. Server caps: 10 variants per fingerprint, 2000 stubs,
100 KB per body (`body_capped`), samples capped at 25; `samples>1` without a
filter is a 400.

### 1.4 GET `{apiUrl}/v1/fixtures?method=&path=[&distinct=status][&limit=N]` (fixtures.py:248-286)

Bearer only, timeout 10 s, base URL `STUBSMITH_API_URL` only. Response:
`{ ok, request_type: { id, method, path_pattern, is_dynamic } | null, count,
fixtures: [{ id, captured_at, method, path, status, duration_ms,
request: { headers, body }, response: { headers, body } }] }`.

## 2. Fingerprint (privacy/fingerprint.py)

- Content-type normalisation: `(ct || "").toLowerCase().split(";")[0].trim()`.
- Key paths (fingerprint.py:208-238, 448-491): blank or whitespace-only body
  gives `[]`. If normalised ct is `application/x-www-form-urlencoded`: the
  keys of `parse_qs(body, keep_blank_values=True)`, or `[]` when any
  non-empty `&`-separated segment has no `=` (`parse_form`; the same rule
  applies to form value types, value pairs and masking). Otherwise, for every
  other ct including empty and text/plain: try JSON parse; on failure `[]`.
  Walk: object emits `prefix.key` (or `key` at root) then recurses;
  non-empty array uses prefix `prefix.[]` (root `[]`) and walks every
  element that is an object or array, unioning with dedup in first-seen
  order; if any element is a scalar, append the bare `prefix.[]` if not
  already seen. Empty arrays and scalars emit nothing.
- Query names: keys of `parse_qs(qs, keep_blank_values=True)` in first
  occurrence order.
- Hash input (fingerprint.py:271-285):

```
raw = sorted(keypaths).join(",") + "|" + sorted(query_names).join(",") + "|" + ct_norm
if value pairs: raw += "|" + sorted(pairs).join(",")
fp = blake2b(utf8(raw), digest_size=8).hex()          // 16 lower-case hex, unkeyed
resp_fp = String(status) + fp(resp_body, SAME request query string, resp_ct)   // no value pairs
```

  `sorted` is Unicode code-point order, not UTF-16 code-unit order.
- Golden values: `"||"` gives `fc552c95a0bb0d3e`;
  `"a,b,b.c,b.c.[],b.c.[].d|x,y|application/json"` gives `1e4594fd8de5d608`
  (body `{"a":1,"b":{"c":[1,{"d":2}]}}`, query `x=1&y=2`, ct
  `application/json; charset=utf-8`); the same plus `|a=1` gives
  `cc3f2ac54ed241d5`.
- Value discrimination pairs (fingerprint.py:321-440): value paths come
  from sync `request_type_value_config[endpoint_id]` or the bundle's
  `fingerprint_value_paths`. JSON: root must be an object; paths are
  dot-split with no `[]` support; each produces `path=canonical`. Canonical:
  bool `true`/`false` (checked before number), string raw, number as Python
  `json.dumps` (int token verbatim, float as Python `repr`: `1.0`,
  `1e+100`, `1e+16`), null `null`, object/array skipped. Form bodies: the
  literal key, first value. If no pair is produced the 4th section is
  omitted.
- Path templating (templating.py): curated templates from sync
  `path_templates` (in replay: the bundle's own templates for the same
  method and domain). Sort templates by literal-segment count descending,
  then template string ascending. Match: same count of non-empty segments;
  each segment equal or a `^\{[^{}]+\}$` wildcard; first match wins.
  Heuristic fallback: split on `/` keeping empties; a segment becomes
  `{id}` when `str.isdigit()` is true (Unicode digits count), or it matches
  UUID `8-4-4-4-12` hex case-insensitively, or it is 16 or more hex
  characters. No percent-decoding.
- `endpoint_id = domain + "|" + METHOD + "|" + path_template` (pipeline.py:171).

## 3. Privacy pipeline (pipeline.py:142-277)

Order: parse URL; case-insensitive content-type lookup; `image/*` bodies
are replaced by a base64 1x1 placeholder with encoding `base64` (GIF for
image/gif, JPEG for image/jpeg and image/jpg, PNG otherwise; constants in
binary.py:31-47) before fingerprinting; template the path and build
endpoint_id; look up value paths; compute req/resp fingerprints, key paths,
value types, header names, query names; `cache.lookup(endpoint_id, req_fp)`;
mask; restore image placeholder bodies; no truncation; assemble payload.
`process()` never throws; a catastrophic error returns null and the capture
is dropped.

Lookup outcomes (pipeline.py:283-337): miss (novel) gives `mask_all` for
request and response and `novel: true`; field rules give `apply_field_rules` and
`apply_resp_field_rules(resp_status)` with extra rules = project defaults
(or none) and the email domain. Extra-rule `field_masks`
(stripped, lower-cased) override keeps: a matching JSON key masks its whole
subtree, a matching form or query field or header name is masked. A masking exception
degrades to `mask_all` with `novel: true`.

`mask_all` (masking.py:209-262): headers keep only the allow-list, every
other header value becomes `<masked>`. JSON: string becomes `<masked>`,
number becomes `0`, bool becomes `false`, null stays null. Form: every value
becomes `<masked>`, re-urlencoded; a form body with a segment without `=` is
unparseable. Anything unparseable, INCLUDING an empty
body, becomes the string `<masked>`. Query: all values `<masked>`,
urlencoded.

Header allow-list (masking.py:73-80), for request and response headers:
content-type, content-length, accept, accept-encoding, host,
transfer-encoding. user-agent, cache-control and accept-language are not on
it.

Field rules (field_rules.py:155-273): `{ path, action: "keep"|"mask"
(default mask), type? }`. Namespaces: `body.`, `query.`, `header.`
(lower-cased), `resp.`, `resp_header.` (lower-cased, independent of
`header.`), and status-scoped `resp:NNN.sub` / `resp_header:NNN.sub` where
NNN is 3 ASCII digits in 100-599 with a non-empty sub, otherwise the rule
is ignored. `path.` is ignored. Generic namespaces record keeps only;
scoped namespaces record keeps and masks. Effective response keep set for
status S = generic keeps + scoped keeps for S − scoped masks for S; mask
wins. `type` hints are recorded only on mask rules.

Scalar-exact keep (field_rules.py:539-589): only a scalar whose exact path
is in the keep set is kept; keeping `user` does not keep `user.x`. Arrays
use `[]` for every element. null stays null. Kept strings go through the
project's regex masks, if any. Masked values: a type hint calls the placeholder generator;
otherwise bool becomes false, number becomes 0, anything else `<masked>`.
Non-JSON, non-form body, and a form body with a segment without `=`, becomes
`<masked>`; an empty body stays `""`.
Form and query: kept values get the project's regex masks, others
`<masked>` or a placeholder; `urlencode(doseq)`.

No built-in patterns: without synced project defaults a kept value is sent
as it is. Masking is never decided by reading a value; observed type labels
(below) are labels only.
`compile_rules` (masking.py): flags containing `i` make the pattern
case-insensitive; empty replace becomes `<masked>`. A pattern that cannot
be used (Python rejects it, or it has no JS translation) marks the rule set
unusable: every string the rules are applied to becomes `<masked>`. Warn
once per process, naming the index. While a regex mask is active, a string
longer than 65,536 characters becomes `<masked>` without running any regex
(UTF-16 code units in Node, code points in Python). Server patterns are
Python `re` dialect: translate `(?P<name>` to `(?<name>`, a leading `(?i)`
to the `i` flag, `\Z` at the end to `$`.

Placeholders (placeholders.py): salt = `STUBSMITH_MASK_SALT` UTF-8, first
64 bytes; empty or absent means constants only. Hash =
`blake2b(utf8(pyStr(value)), key=salt, digest_size=16)` where `pyStr` is
Python `str()`: `True`, `False`, `1.0`, `None`. Guards: bool gives false,
null gives null, `currency_code` and `country_code` always give a constant,
unknown labels become `free_text`, hint/type mismatch gives a constant
(placeholders.py:214-235). Generators (placeholders.py:266-379): email
`hex(b[0..4])@domain`; uuid with v4 bits set on b; iso8601
`YYYY-MM-DDTHH:MM:SS+00:00` with year 2000+b0%24, month 1+b1%12, day
1+b2%28, hour b3%24, minute b4%60, second b5%60; e164 `+1` + 10 digits
b[i]%10; iban `NL` + mod-97 check + 4 letters (A+b%26) + 10 digits; url
`https://{hex b0-3}.stub.invalid/{hex b4-7}`; decimal int =
be32(b0-3)%9999+1, frac = be16(b4-5)%100, output type follows input (string,
float or int); integer_id be64(b0-7)%999999999+1, string in gives string
out; opaque_token hex of all 16 bytes; free_text `text-` + hex(b[0..8]).
Copy the constants from placeholders.py.

Observed type labels (fingerprint.py): read each value's content to pick a
label, which is sent; no masking decision reads it. Vocabulary email, uuid,
iso8601, e164, iban, url, currency_code, country_code, decimal_amount,
integer_id, opaque_token, free_text (the SDK never emits opaque_token).
Order: integer token gives integer_id; float token gives decimal_amount;
strings: uuid, email, iso8601, e164 `^\+[0-9]{7,15}$`, iban
`^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$`, `http(s)://` prefix gives url,
`^[A-Z]{3}$` currency_code, `^[A-Z]{2}$` country_code, `^-?[0-9]+$`
integer_id, `^-?[0-9]+\.[0-9]+$` decimal_amount, else free_text. bool and
null are skipped. Form bodies use the first value. The int versus float
distinction comes from the JSON source token (`1.0` is a float).

## 4. Capture runtime (instrument.py, client.py)

- `install()` is idempotent: returns the existing client when its sender is
  alive and not stopped, ignoring new options. Instruments both hooks.
  `waitForRules` blocks on the first sync. `isInstalled()`.
- Only the outermost frame captures (thread-local guard in Python); in Node
  use `AsyncLocalStorage`. Capture is skipped while replay is active
  (process-global depth counter).
- Wire URL for redirects: the ORIGINAL request URL with the final response.
- Queue: max 1000 items plus a 32 MiB byte budget, both drop silently.
  Sampling: drop when `random() > sampleRate`, after the pipeline. One send
  at a time. Byte reservation released after the send.
- Flush: `flush(timeout=5 s)` polls every 50 ms and stops early on a new
  failure. Exit flush budget `STUBSMITH_FLUSH_TIMEOUT` seconds, default
  1.0, 0 disables. `close()` flushes, stops the cache and un-patches.
- Environment: `STUBSMITH_URL` (ingest, default above), `STUBSMITH_API_KEY`
  (empty disables the SDK entirely: no capture, no pipeline),
  `STUBSMITH_BACKEND_URL` (default above), `STUBSMITH_API_URL` (CLI and
  fixtures; CLI falls back to BACKEND_URL), `STUBSMITH_DEBUG` (1, true,
  yes), `STUBSMITH_FLUSH_TIMEOUT`, `STUBSMITH_MASK_SALT`, `STUBSMITH_BUNDLE`.
- Constructor defaults: timeout 5 s, sampleRate 1.0, rulesPollInterval
  60 s, compress on.

## 5. Replay and bundle (replay.py, cli.py, testing.py)

Bundle schema (`.stubsmith/bundle.json`):

```
{ ok, version: 1, cursor: "N", generated_at,
  project_settings?: { group_ids_in_paths: boolean },
  truncated?: { stubs: { dropped, limit }, variants: [{ endpoint, fingerprint, dropped, limit }],
                body_bytes: { capped, limit } },
  endpoints: [{ domain, method, path_template, is_dynamic, fingerprint_value_paths: [],
    stubs: [{ fingerprint, key_paths, query_names, content_type | null, field_rules, degraded,
      variants: [{ status, count, duration_ms, headers, body | null, body_capped?, body_encoding?,
        samples?: [{ capture_id, captured_at, duration_ms, headers, body, body_capped?, body_encoding? }] }] }] }] }
```

`pull [--out .stubsmith/bundle.json] [--endpoint "METHOD /path"]... [--samples N|all]`
(cli.py:324-493): requires `STUBSMITH_API_KEY`; `samples>1` or `all`
requires `--endpoint`; one request per endpoint, merged by (domain, METHOD,
template), duplicate fingerprints dropped, cursor = max, `truncated`
carried, `project_settings` taken from the last part that has it (omitted when
none does); sort endpoints by (domain, method, path_template), stubs by
fingerprint, variants by status; write atomically with sorted keys, indent
2, trailing newline, mode 0644; exit 0, or 1 on error.

`replay()` (replay.py:1062-1352, 1505-1563): only strict miss mode. When the
bundle's `project_settings.group_ids_in_paths` is false, a request path is
templated as capture does with the setting off; absent or not a boolean means
true. Bundle
resolution: argument (object or path), else `STUBSMITH_BUNDLE`, else walk
upward for `.stubsmith/bundle.json` stopping at the first directory with
`.git` or a project file. Matching: domain = netloc after the last `@`; METHOD; path templated
against the bundle's templates for (method, domain) with heuristic
fallback; body decoded as UTF-8 (`""` on failure); content type from the
request headers; fingerprint uses the endpoint's `fingerprint_value_paths`.
Lookup key is the composite (domain, method, path_template, fp). A miss
throws `StubNotFound(method, pathTemplate, fingerprint, message)` with a
near-miss key-path diff (replay.py:239-456, 459-490). Response order
(replay.py:722-820): the primary variant (count descending, then status
ascending) first, then the others by status; samples newest first. Default
serves the first response; `select` callback; `byStatus(n)` returns null,
which throws. Served response: hop-by-hop headers stripped
(testing.py:123-136), `body_encoding: base64` decoded, object bodies
serialised, `duration_ms` exposed. `served()` lists what was served.

`replayAll(statuses, maxPasses=64)` (replay.py:1381-1502, 973-1026): cursor
per stub key, fixed within a pass, advanced once per pass for the shapes
touched in that pass, clamped at the last response; stops when no unseen
(key, index) pair remains; a statuses filter with no match throws.
