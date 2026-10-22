# Stubsmith Node.js SDK

Instrument **outbound** HTTP calls made by your Node.js application and forward
them, request **and** response, to the Stubsmith ingest service for capture,
anonymization, and replay.

Covers Node's `http` and `https` modules and the global `fetch`, which between
them reach axios, node-fetch, got, superagent and native fetch.  Sending is
non-blocking and fire-and-forget: captures go onto a bounded in-memory queue and
a single sender drains it; any failure (network, serialization, queue overflow)
is silently discarded and never propagates to your application.

Masking is applied **in this SDK**, in your own process, before any capture
leaves it: the ingest service receives masked bodies plus structural names
(field paths, header names, query-parameter names), never original values.  A
field with no explicit `keep` rule is masked, so a field the rules do not
mention cannot leak.  The server does not inspect values; the only content rules
it enforces are replacing image bodies with a placeholder, and storing a path
under its path pattern.

---

## Install

```bash
npm install stubsmith
```

Requires Node.js 22.12 or later.  The package ships ESM and CommonJS builds with
bundled type declarations and has no runtime dependencies.  Bun and Deno are not
supported.

---

## Quickstart

```js
import stubsmith from 'stubsmith';

// One call patches both hooks (http/https and global fetch)
const client = stubsmith.install({ apiKey: 'sk-your-project-key' });

// Now every outbound call is captured automatically:
await fetch('https://api.stripe.com/v1/charges');

import axios from 'axios';
await axios.get('https://api.example.com/users');
```

Or configure via environment variables and call `install()` with no arguments:

```bash
export STUBSMITH_URL="http://ingest:8081/v1/captures"
export STUBSMITH_API_KEY="sk-your-project-key"
```

```js
import stubsmith from 'stubsmith';
stubsmith.install();
```

With no API key the SDK disables itself: nothing is patched into the capture
path and nothing is sent, so the same code runs unchanged in environments
without a key.

CommonJS works the same way: `const stubsmith = require('stubsmith').default`.

**Call `install()` first.** Run it before importing any library that grabs
`http.request` or `fetch` at import time, such as a client that destructures
`const { request } = require('node:https')` at the top of its module.  Such a
library keeps the original function and its calls are not captured.

**Servers must shut down explicitly.** See [Shutdown and
flushing](#shutdown-and-flushing).

---

## What gets captured

`install()` patches two things:

| Hook | Covers |
|------|--------|
| `http.request`, `http.get`, `https.request`, `https.get` | axios (its default http adapter), node-fetch, got, superagent, and anything else built on Node's core modules |
| global `fetch` | native fetch, undici's `fetch`, axios with the fetch adapter, and frameworks that call the global |

Not captured:

- undici's `request()` and `Agent` API used directly
- `http2`
- `XMLHttpRequest` polyfills
- WebSockets
- calls made through a function a library copied from `http` or `fetch` before
  `install()` ran

Only the outermost frame captures: one call produces one capture, and a redirect
chain produces one capture describing the request you made.  Capture is skipped
entirely while a [replay](#offline-replay-in-tests) is active.

Request and response bodies are read without consuming them: the caller still
gets every byte.  A body larger than 16 MiB is not captured, and the SDK warns
once per endpoint.

The SDK's own traffic to the ingest and rules hosts is never captured.

### Network egress

`install()` talks to **two** hosts, which matters if you allow-list egress:

| Host | Direction | Purpose |
|------|-----------|---------|
| `ingest.stubsmith.dev` | outbound POST | masked captures (`POST /v1/captures`) |
| `app.stubsmith.dev` | outbound GET | masking rules (`GET /v1/sdk/sync`), polled every `rulesPollInterval` (default 60 seconds) |

Both are overridable (`url` and `backendUrl`) for a project pointed at a
different environment.  The rules timer is `unref()`ed, so the SDK never keeps
your process alive.

---

## Privacy model

Values are masked in your process, before a capture is uploaded: the server never
receives the originals.  A field with no `keep` rule is replaced, by a constant
of the original's type (`"<masked>"`, `0`, `false`).  URLs are templated (a path
segment such as `1042` becomes `{id}`) and query *values* are masked while their
names survive.  What the ingest service sees is structure: field paths, header
names and query-parameter names.

Six header values are always sent as they are, in requests and responses:
`content-type`, `content-length`, `accept`, `accept-encoding`, `host` and
`transfer-encoding`.  Every other header value, `user-agent`, `cache-control`
and `accept-language` included, is `<masked>` unless a keep rule
(`header.<name>` for the request, `resp_header.<name>` for the response) keeps
it.  Names are structure and are sent as they are: header names, JSON keys,
form field names and query-parameter names.  In a form body that is all
`key=value` pairs, whatever stands before each `=` is a name, so free text such
as `Hi Bob, ref=123` sends `Hi Bob, ref` as a name.

A fingerprint nobody has approved yet is **novel**: every value is masked and the
capture is flagged `novel`.  You review it in the Request Types editor and
approve the fields that are safe to keep; only then do those scalars appear in
captures verbatim, and that is the only way a real value deliberately reaches
Stubsmith. 

The approved rules are fetched from the rules API and re-polled every
`rulesPollInterval`.  **An unreachable rules API degrades open, not closed.** A
failed sync keeps the last known-good rules and never stops capture.  Because
masking is fail-closed, a client that has never reached the API masks everything
and still delivers captures: you get `novel=true` and no cleartext, not silence.
A rejected key (`401`) behaves the same way.

A payload without the SDK's masked marker is rejected by the ingest service with
`400 sdk_required`, so an unmasked body cannot be posted through that endpoint at
all.

Set `STUBSMITH_MASK_SALT` (or the `maskSalt` option) to a non-empty string to get
format-preserving placeholders for fields that carry a semantic type hint from an
approved fingerprint: a parseable timestamp, an RFC 4122 UUID, an IBAN with a
correct checksum.  Before a fingerprint is approved no field has a hint, so
every masked value is the constant form regardless of the salt.

---

## Shutdown and flushing

Captures are masked on the calling path (CPU only, no I/O) and handed to a
bounded queue; a single sender does the HTTP POST and swallows every error.  If
the ingest service is slow, unreachable or returning errors, your request path is
unaffected: the queue fills (1000 items or 32 MiB, whichever comes first),
excess captures are dropped, and nothing propagates to your code.

The one place an outage is visible is process exit.  For a script, the SDK
registers a `beforeExit` hook that waits for the queue to drain, capped at
`STUBSMITH_FLUSH_TIMEOUT` seconds (default `1.0`) and abandoned as soon as a send
fails, so an unreachable endpoint costs about a second rather than the full
budget.  Set `STUBSMITH_FLUSH_TIMEOUT=0` to disable the wait; captures still in
the queue are discarded.

**`beforeExit` only fires when the event loop drains.** A long-lived server never
drains it, so the hook never runs.  Call `await client.close()` from your shutdown
path:

```js
const client = stubsmith.install();
const server = app.listen(3000);

process.on('SIGTERM', () => {
  server.close(async () => {
    await client.close();   // flushes the queue, stops the rules timer, un-patches
    process.exit(0);
  });
});
```

In a serverless function, or anywhere the process can be frozen after you
respond, flush before returning:

```js
export async function handler(event) {
  const result = await doWork(event);
  await client.flush();                    // waits up to 5 s by default
  // await client.flush({ timeoutMs: 500 }) // or pick your own budget
  return result;
}
```

`flush()` returns early if a send fails, so an unreachable endpoint does not
stall the response.  `close()` flushes, aborts a send still in flight, and
un-patches the hooks; it is idempotent.  `STUBSMITH_FLUSH_TIMEOUT` is the budget
for the exit hook only and does not apply to `flush()` or `close()`.

The rules are fetched asynchronously, so captures made in the first moments of a
short script are masked with no rules and are novel.  To wait for the first sync:

```js
const synced = await client.waitForRules(3000);   // true once rules loaded, false on timeout
```

`install()` is idempotent: calling it again returns the client already installed,
ignoring the new options; call `close()` first to reconfigure.  The SDK is per
isolate, so each `cluster` worker or `worker_thread` calls `install()` itself.

Errors are swallowed, refusals are not.  Ingest can accept the HTTP request and
still decline the capture: at the fingerprint cap it answers `200` with
`{"ok": false, "error": "fingerprint_limit_reached"}`, and a quarantined or
rejected shape answers `422` with the same `ok: false` body.  The SDK reads that
body and prints one warning per distinct error code per process, naming the code,
the HTTP status, the consequence and the remedy.  Once per code rather than per
capture, and never thrown.

When a payload exceeds `limits.maxPayloadBytes` (10 MiB), both bodies are dropped
together and the capture is sent with `bodies_omitted`: the endpoint stays
visible and nothing half-captured is stored.  Bodies are never truncated.

---

## Offline replay in tests

`replay()` serves recorded responses to your code's outbound `http`, `https` and
`fetch` calls.  While it is active no network call is made and the dependency
does not need to be running.

Fetch the bundle once and commit it:

```bash
export STUBSMITH_API_KEY=<your project key>
npx stubsmith pull --out .stubsmith/bundle.json
```

From then on the test suite needs no key, no network and no `pull` step: it reads
the committed file.  Refresh it when the recording should change: the upstream
API's shape changed, you added a call the bundle does not cover, or you approved
new fingerprints.  Treat it like a lockfile or a golden file: an occasional,
reviewed, committed change.

`replay()` finds the bundle without configuration: an explicit `bundle` option
(a path or a parsed `Bundle` object), then `$STUBSMITH_BUNDLE`, then an upward
search from the working directory for `.stubsmith/bundle.json` that stops at the
first directory containing `.git` or `package.json`.  In a monorepo, where the
nearest `package.json` belongs to a package below the one holding the bundle, set
`STUBSMITH_BUNDLE` or pass a path, because the upward walk stops at that
`package.json`.

`replay()` returns a context and installs its hooks immediately.  Call
`restore()` when the test ends.  Restore contexts in the reverse order you created
them.

Replay patches `http.request`, `http.get`, `https.request`, `https.get` and the
global `fetch`.  `undici.request()`, `http2`, and a `fetch` or `http.request`
reference captured before `replay()` ran bypass replay and still hit the network.
A recorded 3xx under global `fetch` is returned as-is: the redirect is not followed.

### Vitest

```js
import { afterEach, beforeEach, expect, test } from 'vitest';
import { replay, byStatus, StubNotFound } from 'stubsmith';

let ctx;
beforeEach(() => {
  ctx = replay();
});
afterEach(() => {
  ctx.restore();
});

test('reads a recorded user', async () => {
  const res = await fetch('http://localhost:8081/api/users/4821');
  expect(res.status).toBe(200);
  expect(ctx.served().map((s) => s.status)).toEqual([200]);
});

test('an unrecorded call never reaches the network', async () => {
  await expect(fetch('http://localhost:8081/api/nope')).rejects.toBeInstanceOf(StubNotFound);
});

test('handles the recorded 404', async () => {
  ctx.restore();
  ctx = replay({ select: byStatus(404) });
  const res = await fetch('http://localhost:8081/api/users/1');
  expect(res.status).toBe(404);
});
```

To install it for every test file, put the `beforeEach`/`afterEach` pair in a
module listed under `setupFiles` in the Vitest config.

### Jest

Jest gives each test file its own module registry, so `replay()` has to be called
from a file Jest runs inside that registry: either the test file itself, or a
module listed under `setupFilesAfterEnv`, which Jest runs once per test file.

```js
// jest.setup.js, listed in jest.config.js as setupFilesAfterEnv: ['./jest.setup.js']
const { replay } = require('stubsmith');

let ctx;
beforeEach(() => {
  ctx = replay();
});
afterEach(() => {
  ctx.restore();
});
```

```js
// orders.test.js
const { replay, byStatus, StubNotFound } = require('stubsmith');

test('handles the recorded 404', async () => {
  const pinned = replay({ select: byStatus(404) });
  try {
    const res = await fetch('http://localhost:8081/api/users/1');
    expect(res.status).toBe(404);
  } finally {
    pinned.restore();
  }
});

test('an unrecorded call never reaches the network', async () => {
  await expect(fetch('http://localhost:8081/api/nope')).rejects.toBeInstanceOf(StubNotFound);
});
```

### Every recorded response, not just the newest

`replay()` serves **one** response per request shape: the newest recording of the
status that occurred most often.  That leaves everything else in the recording
unexercised, which is usually where the bugs are.  Stubsmith keeps a rolling
window of recent samples for each distinct response a shape returned, so the 429
and the 500 your API really produced are sitting there unused.

`replayAll()` is an async generator that runs the block once per recorded
response.  Pass `statuses` to loop one kind:

```js
import { replayAll } from 'stubsmith';

test('parses every recorded success', async () => {
  for await (const pass of replayAll({ statuses: [200] })) {
    const result = await connector.syncOrders();
    expect(result.orders).toBeDefined();
  }
});

test('degrades on every recorded failure', async () => {
  for await (const pass of replayAll({ statuses: [429, 500] })) {
    await expect(connector.syncOrders()).rejects.toThrow();
  }
});
```

Each iteration yields an active context, restored when the loop body finishes,
throws or `break`s.  `pass.passNumber` is the 1-based pass.

**Filter by status unless you have a reason not to.** It decides what a red
build means.  Unfiltered, the loop feeds successes and failures into one test
body, so the body has to hold for both; the day a 500 first appears in the
window, assertions written when only 200s existed start failing, and the build
breaks because the recording changed rather than because the code did.  Filtered,
every pass is the same kind of response, the assertions can be specific, and a
failure means your code cannot handle a response your API genuinely returns.  The
filter also bounds the work: `maxPasses` (default 64) is a backstop, not a plan.

A shape with recordings but none of the requested status throws `StubNotFound`,
naming the filter and listing the statuses it does have.  Serving a different one
would make the loop assert against a response it was told to exclude.

You never name an endpoint.  Which ones a pass touches is discovered by running
your code, so this works for a connector whose call sequence changes between
passes because it branches on the response it got.  Pass one serves exactly what
`replay()` serves (without a `statuses` filter).  The loop stops when every shape
that was actually touched has served its last recording; a shape with a shorter
window keeps serving its final recording rather than throwing.

To pin a single response instead, pass `select`:

```js
const ctx = replay({ select: byStatus(429) });
```

`byStatus` throws `StubNotFound` when no recording of that status exists, rather
than quietly serving a different one: a rate-limit test that silently ran against
a 200 would pass while testing nothing.  `select` receives every recording of the
shape as an array and returns one, so any other rule is a function away.  Each
recording has these fields: `status`, `count`, `durationMs`, `headers`, `body`,
`bodyEncoding`, `bodyCapped`, `captureId` and `capturedAt`.  They are camelCase,
unlike the snake_case keys in the bundle JSON (`duration_ms`, `body_encoding`).

Either way, `served()` reports what actually ran, so a test can assert coverage
instead of assuming it:

```js
const ctx = replay();
try {
  await connector.syncOrders();
  console.log(ctx.served().map((s) => [s.endpoint, s.status]));
} finally {
  ctx.restore();
}
```

Each entry carries `endpoint`, `status`, `captureId`, `capturedAt`, and
`index`/`total`/`exhausted` describing its place in the shape's window.

#### Getting the window into the bundle

A default bundle holds one recording per response, so `replayAll()` gives one pass
per status.  Ask for the window explicitly:

```bash
npx stubsmith pull --endpoint "GET /admin/orders" --samples all \
  --out tests/bundles/admin-orders.json
```

`--samples` above 1 requires `--endpoint`: the full window for a whole project is
not served.  Repeat `--endpoint` to cover several in one file, which is one
request per endpoint, merged for you.

Or fetch at test time, with no file involved:

```js
import { fetchBundle, replayAll } from 'stubsmith';

const bundle = await fetchBundle('GET /admin/orders', { samples: 'all' });

for await (const pass of replayAll({ bundle })) {
  await connector.listOrders();
}
```

Fetch once, not per test: it is a network call.  It needs a live key wherever the
tests run, and live recordings roll as the window rolls, so a failure you see
today may not reproduce next week.  Fetch live while iterating locally; commit a
pulled bundle for CI.

### Matching

A request is matched on `(domain, method, path_template, fingerprint)`.  The
fingerprint covers body key-paths, query parameter names and the normalised
content-type, not values, and not the host or path, which is why the other three
parts of the key are needed.  Every body-less `GET` shares one fingerprint.

Dynamic path segments are templated from the recording, so `/api/users/4821`
matches a stub recorded as `/api/users/{id}`.

### When nothing matches

`StubNotFound` is thrown with a diff of what was sent against the closest
recording.  It never falls through to the network, so a test cannot silently start
calling a real service.  It carries `method`, `pathTemplate` and `fingerprint`.

A stub whose fingerprint has no recorded captures is reported as `degraded` by
`stubsmith pull` and throws the same error at replay time, rather than serving an
empty response.

See [`examples/express/`](examples/express/) for a runnable service with a replay
test that passes offline.

---

## Fetching fixtures

`fixtures()` fetches the recorded response variants for one request type, newest
first, for tests that want a raw recorded exchange rather than a replay:

```js
import { fixtures, fixturesBundle } from 'stubsmith';

const fxs = await fixtures('POST /v1/charges/{id}', { distinct: 'status' });
console.log(fxs[0].status, fxs[0].response.json());

const bundle = await fixturesBundle('POST /v1/charges/{id}');
const declined = bundle.byStatus(402);   // throws, naming the statuses present, if there is none
console.log(declined.response.json());
```

Both take `"METHOD /path"`.  Options are `distinct: 'status'` (at most one fixture
per HTTP status), `limit` (1 to 100), and `apiUrl` and `apiKey`, which default to
`$STUBSMITH_API_URL` and `$STUBSMITH_API_KEY`.  `fixtures()` returns the
`Fixture[]`; `fixturesBundle()` returns the full envelope, including `count` and
`requestType`.  Each `Fixture` has `id`, `capturedAt`, `method`, `path`, `status`,
`durationMs`, and `request` and `response` sides with `headers`, `body` and
`json()`.  These requests are never captured by the SDK.

---

## CLI

```bash
npx stubsmith pull [--out PATH] [--endpoint "METHOD /path"]... [--samples N|all]
npx stubsmith --version
```

| Flag | Default | Description |
|------|---------|-------------|
| `--out PATH` | `.stubsmith/bundle.json` | Destination file; parent directories are created |
| `--endpoint "METHOD /path"` | whole project | Filter to an endpoint such as `"GET /api/users/{id}"`. Repeat to pull several into one bundle: each is one request, merged for you |
| `--samples N\|all` | `1` | Recordings to keep per response (the newest). Above 1 requires `--endpoint` |

`pull` requires `STUBSMITH_API_KEY` and exits `1` on any error, `0` on success.
It prints a summary and warns when the server truncated the bundle or marked
stubs `degraded`.  A project-wide bundle is capped at 2000 request shapes, and
what it drops is reported in `truncated` rather than carried; per-endpoint
scoping is what you want anyway.

The same operations are available from code as `fetchBundle()` (one request) and
`pullBundle()` (several, merged, with a summary).

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STUBSMITH_API_KEY` | none | Project key, sent as a bearer token. An empty value disables the SDK |
| `STUBSMITH_URL` | `https://ingest.stubsmith.dev/v1/captures` | Full URL of the ingest endpoint |
| `STUBSMITH_BACKEND_URL` | `https://app.stubsmith.dev/api` | API the masking rules are fetched from. A **second host**, not the ingest host |
| `STUBSMITH_API_URL` | falls back to `STUBSMITH_BACKEND_URL` for `pull`, then the default above | API for `stubsmith pull` and `fetchBundle()`; for `fixtures()` it falls back to the default above |
| `STUBSMITH_DEBUG` | off | `1`, `true` or `yes` logs send and sync failures to stderr. Does not change the fire-and-forget contract |
| `STUBSMITH_FLUSH_TIMEOUT` | `1.0` (seconds) | How long process exit waits for queued captures to drain. `0` disables the wait. A malformed value falls back to the default |
| `STUBSMITH_MASK_SALT` | none | Non-empty switches on format-preserving placeholders for fields with a type hint |
| `STUBSMITH_BUNDLE` | none | Path to the replay bundle, used when `replay()` is not given one |

### `install()` options

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | `$STUBSMITH_API_KEY` | Bearer token; empty auto-disables the client |
| `url` | `$STUBSMITH_URL` / `https://ingest.stubsmith.dev/v1/captures` | Full URL of the ingest endpoint |
| `backendUrl` | `$STUBSMITH_BACKEND_URL` / `https://app.stubsmith.dev/api` | API the masking rules are fetched from |
| `timeoutMs` | `5000` | HTTP timeout for an ingest POST |
| `sampleRate` | `1` | Fraction of captures to forward (0 to 1) |
| `rulesPollInterval` | `60000` (ms) | How often the rules cache re-polls the API |
| `compress` | `true` | gzip capture payloads of 1 KiB or more before sending |
| `debug` | `$STUBSMITH_DEBUG` | Log send and sync failures to stderr |
| `maskSalt` | `$STUBSMITH_MASK_SALT` | Placeholder salt; given here it is used directly and the environment is not modified |
| `limits.maxQueueItems` | `1000` | Bound on the send queue; excess captures are dropped |
| `limits.maxQueueBytes` | `33554432` (32 MiB) | Ceiling on bytes held in the queue, separate from the item bound |
| `limits.maxPayloadBytes` | `10485760` (10 MiB) | Largest capture payload sent. Over it, bodies are omitted rather than cut. Must match the server's limit |

**An explicit option always wins over the environment variable**, which is read
only when the option is omitted, and only once, when the client is built.
`install({ apiKey: 'sk-from-arg' })` authenticates with `sk-from-arg` even if
`$STUBSMITH_API_KEY` is set to something else.  That matters when the key comes
from a database row or a secrets manager rather than the process environment.

The client returned by `install()` has `flush()`, `close()`, `waitForRules()` and
an `enabled` flag that is `false` when no key was given.  `stubsmith.isInstalled()`
is `true` while a client is installed and not closed.

---

## Limitations

- **Hook coverage.** Only `http`, `https` and the global `fetch` are patched.
  undici's `request()` and `Agent` API, `http2`, `XMLHttpRequest` polyfills and
  WebSockets are not captured, and neither is a library that copied
  `http.request` before `install()` ran.
- **Runtimes.** Node.js 22.12 and later. Bun and Deno are not supported.
- **Long-lived servers** never fire `beforeExit`, so they must `await
  client.close()` on shutdown or the last captures can be lost.
- **Unread responses.** A response whose body is first read more than one second
  after the headers arrived is captured with an empty body.  The reader still gets
  every byte; the capture is not made a second time.
- **Body size.** A body over 16 MiB is not captured.  A capture whose payload
  exceeds 10 MiB is sent with both bodies omitted.
- **Per isolate.** Each `cluster` worker or `worker_thread` calls `install()` for
  itself.
- **Jest.** Each test file has its own module registry, so call `replay()` from
  the test file or a `setupFilesAfterEnv` module (see above).

---

## Development

```bash
npm install
npm test            # vitest, including the conformance vectors
npm run typecheck
npm run lint
npm run build
```

The masking and fingerprinting code is checked against golden vectors in
`conformance/vectors/`, produced by the reference Python SDK; see
`conformance/README.md`.  Never edit the vectors by hand.  To regenerate them,
point `PYTHONPATH` at a checkout of the Python SDK:

```bash
PYTHONPATH=/path/to/stubsmith-python python3 tools/gen-vectors.py
```

## Licence

MIT. See [LICENSE](LICENSE).
