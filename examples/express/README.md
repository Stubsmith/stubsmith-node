# Express example

A small Express service instrumented with the Stubsmith Node SDK.  It has two
routes, each calling an upstream API a different way, and a test that replays
recorded responses with no network and no API key.

| Route | Upstream call | Hook that captures it |
|-------|---------------|-----------------------|
| `GET /orders/:id` | `fetch` to `$UPSTREAM_URL/api/orders/:id` | global `fetch` |
| `GET /users/:id` | `axios` to `$UPSTREAM_URL/api/users/:id` | `http` / `https` |

`server.js` calls `stubsmith.install()` first, so it picks up its settings from
the environment.  On `SIGTERM` it closes the HTTP server and then awaits
`client.close()`, which flushes queued captures.  A server never drains its event
loop, so without that call the SDK's exit hook would not run.

## Run it against a project key

```bash
npm install
export STUBSMITH_API_KEY=<your project key>
export UPSTREAM_URL=https://api.example.com   # an API you want to record
npm start
```

Then call the service:

```bash
curl localhost:3000/orders/1042
curl localhost:3000/users/4821
```

Without `STUBSMITH_API_KEY` the SDK disables itself and the service runs
unchanged; the startup line says `capture off`.  `UPSTREAM_URL` defaults to
`http://localhost:8081`, and `PORT` to `3000`.

## What to expect in the review queue

Each distinct request shape the service makes appears in your project as a
**novel** fingerprint, one per route here (`GET /api/orders/{id}` and
`GET /api/users/{id}` on your upstream host, with the id templated).  Nothing
has been approved yet, so every value in those captures was masked in this
process before it was sent: the dashboard shows field paths, header names and
query-parameter names, and no original values.

Open the Request Types editor, review each fingerprint, and approve the fields
that are safe to keep.  After the next rules sync (the SDK polls every 60
seconds) kept fields arrive verbatim in new captures.  Then pull the recording
for use in tests:

```bash
npx stubsmith pull --out .stubsmith/bundle.json
```

If you point the service at a different upstream, replace the checked-in
`.stubsmith/bundle.json` with your own pull and update the assertions in the
test.

## Run the test offline

```bash
npm install
npm test        # node --test
```

`test/orders.test.mjs` uses `node:test` and `replay()` against the small
`.stubsmith/bundle.json` committed here, trimmed to two endpoints
(`GET /api/orders/{id}` and `GET /api/users/{id}`, recorded against
`localhost:8081`).  `replay()` finds the bundle by walking up from the working
directory, so run the test from this directory.  No server runs and no key is
needed: the `fetch` and `axios` calls are answered from the file.  The last test
uses `byStatus(404)` to exercise the recorded not-found response.

`package.json` depends on the SDK as `file:../..`, which links this checkout, so
build it first (`npm run build` in the repository root) if `dist/` is missing.
