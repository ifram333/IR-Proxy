# Architecture

A technical tour of how the IR Proxy is put together. For usage and
setup see [README.md](./README.md); for the admin/CLI API see
[API_USAGE_GUIDE.md](./API_USAGE_GUIDE.md).

## Big picture

The server runs in **two tiers** that share the same mock pipeline and state:

1. **Per-instance Express servers** ([server.js](./server.js)) — one HTTP server
   per instance in `state.json` whose SSL proxying is on (e.g. `api` on
   `:3000`, `auth` on `:3001`). These are convenient direct endpoints for local
   testing and for the CLI, but they **duplicate** what the proxy already does
   for the same targets, so they are **off by default** to keep the footprint
   small. They can be started/stopped **at runtime** — from the dashboard header
   toggle or `npm run mock -- standalone --on/--off` (via `POST /__admin/standalone`,
   mediated by [utils/standalone-manager.js](./utils/standalone-manager.js)) — and
   the choice persists in `state.json`. They also start at boot via
   `STANDALONE_INSTANCES=1` or `config.proxy.standaloneInstances = true`. The
   per-instance **state slices** are always initialised regardless, because the
   proxy and admin router read them.
2. **Unified TLS-intercepting proxy** ([proxy-server.js](./proxy-server.js),
   default port `8888`, falling back to the next free port — typically `8889`).
   You set this as your device/Wi-Fi HTTP proxy. It MITM-decrypts HTTPS **only**
   for hosts whose SSL proxying you have turned on (see
   [Per-host SSL proxying](#per-host-ssl-proxying)) and tunnels everything else
   through as raw TCP — while still **recording** that the host was contacted.
   It also serves the dashboard UI at its root. Each intercepted instance's
   Express app + its wrapping `http.Server` are built **once and cached**
   (`getInstanceApp`), then reused across every request/connection.

Both tiers build their request handlers from the same factories so mock
behaviour is identical no matter how a request arrives.

```
              ┌──────────────── serverConfigs (from state.json) ─────────────────────────┐
              │                                                                            │
 device ──► proxy-server.js :8888 ──┐                              server.js :3000/:3001/…
 (HTTP proxy)   • CONNECT            │  shared factories            • one Express app per target
                │                    ├─► utils/mock-pipeline.js ◄───┘  (only where ssl is on)
                ├─ shouldMitm? ──yes─┤     createMockMiddleware
                │  (interception.js) │     createProxyHandler
                │                    ├─► utils/request-log.js ─┐
                └─ no → raw tunnel   │                          ├─► utils/sse-hub.js ─► dashboard
                        │            └─► utils/host-registry.js ┘        (one EventSource)
                        └──── recorded either way ───┘
```

## Per-host SSL proxying

The single most consequential branch in the codebase is "do we TLS-terminate
this host, or tunnel it blind?". It lives in **one pure, tested function** —
[utils/interception.js](./utils/interception.js) `shouldMitm(hostname, ctx)` —
called from the two places the proxy can learn of a host:
`proxy-server.js`'s `connect` handler (HTTPS) and `handlePlainHTTP` (HTTP).

```js
shouldMitm(host, { serverConfigs, hostSettings });
//  → hostSettings[host].ssl === true  AND  an instance exists for that host
```

`store.hostSettings[host]` is `{ ssl, focus, instanceId }`, persisted in
`state.json` — but **only for hosts the user acted on**, because a dev browsing
through the proxy surfaces hundreds of CDN hosts.

- **Discovered hosts default to `ssl: false`.** They are recorded and shown in
  the tree, but never decrypted, so merely pointing a device at the proxy can't
  break a certificate-pinned app.
- **`/__admin` mounts unconditionally.** The router used to be built only when
  `serverConfigs[0]` existed. With an empty seed that leaves the dashboard's
  HTML served by the static handler and every API call it makes 404ing — a page
  that looks alive and can do nothing, including add the instance that would fix
  it. See `tests/empty-state.test.js`.
- **Nothing ships as a target.** `state.example.json`, the seed a fresh clone
  boots from, carries an empty `instances` list: which hosts are worth
  intercepting is a fact about the project being tested, not about this tool.
  A clone therefore starts inert and fills its tree from real traffic — and
  since discovered hosts default to `ssl: false`, filling it decrypts nothing.
  An instance appears the first time somebody turns SSL on for a host, or adds
  one explicitly, and `ssl: true` is then seeded because typing a target in
  means you want it intercepted.

**A host _is_ an instance.** Enabling SSL on a discovered host promotes it via
`instanceManager.ensureInstanceForHost` (idempotent, unlike `addInstance` which
409s on a duplicate). Everything downstream — `createLoggerMiddleware(id)`, the
`isActive` gate, the `servers` scope predicate, capture-session filtering — is
keyed by `instanceId`, so a parallel "generic host" pipeline would mean two
identity systems forever.

Promoted instances get a real port, like any other. That used to be `port: null`
to stop the standalone tier binding one listener per browsed host; promotion only
happens when SSL proxying is switched on, so the set is bounded by what the user
deliberately enabled — and the tier now gates on that flag rather than on the
port (`isStandaloneEligible`). Toggling SSL therefore starts and stops exactly
that host's listener, via `standaloneManager.sync()`.

Disabling SSL only clears the flag and stops the listener. It deliberately does
**not** remove the instance — `removeInstance` deletes `instanceStatus[id]`,
taking every mock toggle for that host with it — and it keeps the port, so the
host comes back on the same one. Deleting the host from the tree _does_ remove
all of it; the confirm dialog says how many toggles that costs.

## Host registry

[utils/host-registry.js](./utils/host-registry.js) records every host a device
reaches for, decrypted or not — closing the blind spot where `handlePassThrough`
piped bytes and forgot. `seen({host, port, protocol})` is called on the CONNECT
hot path _before_ the MITM branch, so it must stay cheap and must never touch
disk.

Records are runtime-only and LRU-capped (`MAX_HOSTS`), and a host with SSL
enabled or explicitly focused is never evicted. Two counters, deliberately:
`connections` (CONNECT tunnels — all you can see with SSL off, and one tunnel
carries many requests) and `requests` (decrypted, folded in via
`requestLog.onEntry`). Calling the former "requests" would be a lie.

Updates are coalesced into one batched SSE frame per ~400 ms, on the named
`hosts` channel — a browser opening 60 connections must not produce 60 frames.

## Request lifecycle

Each request flows through the same middleware chain (`server.js` /
`proxy-server.js → buildInstanceApp`):

0. **Body capture** ([utils/body-capture.js](./utils/body-capture.js)): the JSON,
   form and text parsers, mounted so that reading a body never alters it. The
   raw bytes are kept (`keepRaw`) and re-sent verbatim by the proxy handler
   (`writeRawBody`) instead of being re-serialised from `req.body`, and anything
   over `MAX_PARSE_BYTES` (`IR_PROXY_MAX_PARSE_BYTES`, 5 MB) is left unparsed and
   streamed through rather than refused — the proxy never authors a `413` the
   upstream did not send.
1. **Logger** ([utils/request-log.js](./utils/request-log.js)
   `createLoggerMiddleware`) wraps `res.write`/`res.end` to capture the full
   request/response (headers + bodies), then records and broadcasts the entry.
2. **Admin router** ([utils/admin-router.js](./utils/admin-router.js)) handles
   anything under `/__admin`. The routes themselves live in
   [utils/admin/](./utils/admin/), one module per domain; the router file owns
   only the context they share and the order they mount in. A helper belongs in
   the router file **only** when two domains need it — everything else stays
   with its single caller, which is what stops that file becoming a junk drawer
   again.
3. **Mock middleware** ([utils/mock-pipeline.js](./utils/mock-pipeline.js)
   `createMockMiddleware`): if the instance is active and an **enabled** mock's
   `match(req)` returns truthy, it responds from the mock (tagging
   `req.logSource = "mock"`). An `interceptResponse` mock instead flags the
   request for response transformation and falls through to the proxy. The
   response is delayed by `mock.delay` **plus** the instance's simulated
   `latency` (see State model).
4. **Proxy handler** (`createProxyHandler`, `http-proxy-middleware` with
   `selfHandleResponse`): forwards to the instance's `targetUrl` with a 30s
   timeout (an unreachable upstream answers `502` instead of hanging). In the
   `proxyRes` interceptor (which receives the body already gunzipped) it
   applies the instance latency and any intercept-transform, then tags
   `req.logSource = "proxy"` / `"intercept"`. Transform guards: without a
   transform the bytes pass through **untouched** (binary-safe); transforms
   only run on JSON content types; a throwing transform serves the original
   body and surfaces the message as `transformError` on the log entry.
   The request body it writes is the bytes `body-capture.js` kept, not a
   re-serialisation of `req.body`. On the way in, a **composed** body destined
   for `x-www-form-urlencoded` is turned into a payload by
   [utils/form-encode.js](./utils/form-encode.js), which serialises a nested
   object as JSON and an array as repeated keys instead of letting
   `URLSearchParams` render them `[object Object]`.
   Before forwarding, `restoreHeaderCase` puts the request's field **names**
   back the way the client spelled them: Node's parser folds them to lowercase
   in `req.headers`, which is what http-proxy builds the outbound request from,
   so `tokenId` would otherwise reach the backend as `tokenid`. The names are
   recovered from `req.rawHeaders`; values are untouched, and `host` stays
   `changeOrigin`'s. The **log** still records `req.headers`, so entries — and
   the capture clients that read them — keep the lowercase keys; the spellings
   ride along in `requestHeaderCase`, which the inspector, its cURL copy and the
   retry editor rejoin through `withHeaderCase` (`public/js/modules/util.js`). A
   replay re-spells the captured headers before sending, and `sendViaProxy`
   normalises whatever it is handed and renames once, last — its hop-by-hop
   strip and its content-type checks all match on the lowercase form.

## Request log (SSE)

[utils/request-log.js](./utils/request-log.js) keeps the last **1000** entries in
memory. Each stored request/response body is capped at **256 KB**
(`MAX_BODY_CHARS`, flagged `truncated` — plus granular
`requestTruncated`/`responseTruncated`) and the logger stops buffering a
response once that cap is hit, so a few large payloads can't grow memory
unboundedly. Entries also carry `replayed` (re-sent from a capture), `composed`
(typed from scratch in the dashboard) and `transformError` (an
intercept-transform failed or was skipped). The first two are separate flags on
purpose: while reading the log, "I re-sent something that really happened" and
"I made this request up" answer different questions, and only the second
explains an entry no device ever produced.

Every entry records **where it went**: `host`, `port`, `protocol`, plus
`durationMs` (measured with `process.hrtime.bigint()`, mock delay and simulated
latency included — it's what the client experienced). `instanceId` stays for
backwards compatibility with capture sessions and the CLI.

Resolving the host is fiddly, so it lives in one place (`_resolveOrigin`):
`handleMITM` stashes the CONNECT target on the TLS socket (`__irProxyHost` /
`__irProxyPort`), which is the only fully reliable source. The `Host` header is
next-best and correct for plain-HTTP proxying, but reads `localhost:3000` on the
standalone tier — those pass `trustHostHeader: false` and fall back to the
instance's configured target.

- `GET /__admin/events` — registers an SSE client.
- `GET /__admin/log-history?limit=N` — backfill on page load.
- `POST /__admin/log-clear` — no body clears everything; `{ host }` clears one
  host (the tree's per-host "Clear log").
- `POST /__admin/replay { id, overrides?, expect? }` — re-sends a captured request
  **through the proxy itself** (absolute-form loopback to `store.proxyPort`,
  exactly like a device would), so it traverses the full pipeline and lands in
  the log as a new `replayed` entry. Refused with `409` when the request body
  was truncated, or when SSL proxying is off for the host (it would be tunneled
  straight upstream — no mocks, nothing logged).
- `POST /__admin/send { instanceId, method, path, headers?, body?, expect? }` — the same
  loopback for a request **composed from scratch**, flagged `composed`. With no
  captured entry to inherit from, the instance is chosen rather than derived,
  `path` is required, and a non-string body with no `content-type` defaults to
  JSON.

Both routes share `sendViaProxy`, which is where the guarantees live: the
target host comes from the instance and **cannot** be set by the caller, the
origin flag is re-forced after the caller's headers so it can't be forged, and
`Content-Length` is set explicitly (without it Node sends `chunked`,
http-proxy-middleware adds its own length when forwarding, and the upstream
rejects the malformed result). Going the long way round instead of calling the
upstream directly is the point: the request meets the same mocks, latency and
503 switch a device would.

### Request variables

A request may carry `variables: { name: value }`, and its path, header values
and body may use them:

```
/orders/{{ orderId }}?q={{ query | encodeURIComponent }}
authorization: Bearer {{ token }}
```

[utils/template.js](./utils/template.js) is the rule, pure like `blocking.js`.
Filters are a **closed list** — `encodeURIComponent`, `encodeURI`, `base64`,
`json`, `trim`, `uppercase`, `lowercase` — and anything else is refused by name.
There is deliberately no expression evaluation: `{{ a + b }}` is an error, not a
thing that quietly works, because the alternative is `eval` on the send path.

**Resolution is server-side, in `sendViaProxy`** — the one point the dashboard's
Send, a collection run, the CLI and the three clients all pass through. Doing it
in the dashboard would mean a saved request sent by id went out with its braces
intact, which is the drift `/saved-requests/:id/send` exists to prevent.

**An undefined variable is a 400, never an empty string.** Substituting nothing
sends a blank token and comes back 401 — a failure that says nothing about its
own cause. A malformed `{{ … }}` is refused rather than passed through as
literal text, for the same reason: `{{ user id }}` is somebody reaching for a
variable. To send a literal `{{`, put it in a variable; there is no escape
syntax to remember.

**The resolved request is validated a second time.** `validateRequestFields`
runs before resolution on the template text and again afterwards on the result.
That second pass is not belt-and-braces — it is the only thing standing between
a variable holding `\r\n` and an injected header or request line, since the
first pass sees no newline at all. It is also what lets a path _start_ with a
template (`{{ base }}/orders`): the `/` rule is deferred to the pass that sees
what actually goes on the wire, not relaxed.

On `POST /saved-requests` the templates are checked for **shape** but not for
resolvability (`assertParsable`): a `{{ token | encodeUri }}` typo is refused
while the editor that can fix it is still open, but an undefined variable stays
legal — a suite supplies it at send time.

A composed body is always sent with a **declared content-type** —
`application/json` for an object, `text/plain; charset=utf-8` for a string,
which is what the editor produces when the text is not JSON. A body with no type
is claimed by no parser, so `req.body` stays undefined, the mock sees nothing and
the activity log (which records `req.body`) records nothing: the request goes out
complete and reads as though its body was dropped. The instance app parses
`text/*` and XML for the same reason — the default alone would not help, since it
is the parser that puts the body somewhere the log can see it.

**A Send writes the variables back**, and only the variables
(`PATCH /__admin/saved-requests/:id`). Sending is otherwise not saving here — a
path or body typed into the editor is a one-off, and closing the modal is meant
to throw it away. Variables are the exception because they are the request's
_inputs_ rather than its content: the reason to put a value in that tab instead
of inline in the path is so that it stays, and one that evaporated on every Send
would leave the tab useful only to whoever remembered to press Save afterwards.
That is also why the route is narrow rather than a re-save of the whole record,
which would quietly persist the edits that are supposed to be temporary.

`POST /saved-requests/:id/send` **merges** supplied variables over the stored
ones, where `expect` on the same route replaces. An expectation is one whole
statement about the answer, so half of it is meaningless; variables are
independent values, and the reason to pass any from outside is usually a single
one — the credential the file should not be carrying.

### Response expectations

Either route may carry `expect: { status?, schema? }` — what a good answer looks
like. The reply then gains `expect: { passed, errors }`; without one it keeps
exactly the shape it always had.

`ok: true` still means **"it went out and came back"**. A response that failed
its expectation is a successful send of a request whose answer was wrong, and
the two have to stay distinguishable — the collections row shows `200 ✗`, not a
red X where the status belongs.

**The body is buffered only when there is an expectation to read it.** Without
one `sendViaProxy` keeps the `upstream.resume()` drain it has always had, so
running a collection of unchecked requests costs what it did before. With one it
accumulates up to 1 MB and, past that, reports that it could not check rather
than validating a fragment — the same call the replay route makes when the log
truncated a request body. `accept-encoding: identity` is already forced upstream
of this, so what arrives is the plain bytes.

This is also **why the check lives on the server**: the untruncated response
body exists nowhere else. By the time the dashboard could read one it has been
through `request-log.js` and been cut to `IR_PROXY_BODY_CHARS`.

[utils/schema-validate.js](./utils/schema-validate.js) is the rule, pure like
`blocking.js` and for the same reason. It implements a **subset** of JSON Schema
— `type` (a name or a list), `required`, `properties`, `items`,
`additionalProperties`, `enum`, `const`, `minimum`/`maximum`,
`minLength`/`maxLength`, `minItems`/`maxItems`, `pattern` — and **refuses
everything else by name**: `$ref`, `allOf`/`anyOf`/`oneOf`, `format`,
`patternProperties`, and any keyword it has never heard of.

That refusal is the whole point of the module. A validator that skips the
keyword carrying the actual constraint reports green for a response it never
checked, which is the one failure mode that would make this feature worse than
not having it. `assertSupported` runs on **save** as well as on send, so a
schema that could never be honoured is a `400` while you are still looking at
it. It also compiles every `pattern` there, so a broken regex fails in the
editor rather than halfway through a run.

#### Schema files

An expectation lives inside its saved request, which is right for the request
and wrong for everything else: a schema is a contract several requests may hold
to, the CLI reads one off disk (`--schema-file`), and CI reads the same file. So
the Expect pane can also write it to `schemas/`, and read one back.

[utils/schema-store.js](./utils/schema-store.js) owns that directory, and **the
file is the schema** — no envelope, no `id`, no `savedAt`. Wrapping the document
would mean a file written from the dashboard could not be handed to
`--schema-file` without unwrapping it, and being handed to the CLI is the entire
reason it is a file rather than a field. The consequence is that the listing's
metadata comes off the filesystem (`mtime`, size), which is the honest source
for something anybody may also edit in their editor or pull from a branch. The
display name rides along as `title`, JSON Schema's own field for it and one the
validator already carries as an annotation.

`POST /__admin/schemas` runs `assertSupported` **before writing**, so a schema
saved from the dashboard cannot be one a run would refuse — the refusal lands
while you are still looking at the editor. A file dropped into the directory by
hand still gets refused, just later, by the same function on the send.

Saving over an existing name **overwrites**, where `request-store.js` would
disambiguate with a number. Here the id is the whole identity — it is what you
type after `--schema-file` — so a silent `order-2.schema.json` would be a file
nobody meant to make and nobody would think to reference. The dashboard warns
first instead, the same call `validateMockPath` makes.

Unlike `requests/`, `schemas/` is **not gitignored**. A saved request carries
headers and headers carry `Authorization`; a schema carries the contract, and
belongs in review with the code it holds to account.

- `GET /__admin/schemas` — ids, titles and filesystem facts, not the documents.
- `GET /__admin/schemas/:id` — one schema.
- `POST /__admin/schemas { name, schema }`
- `DELETE /__admin/schemas/:id` — the requests referencing it keep their own
  copy of the expectation, so this disarms no check.

### Saved requests

- `GET /__admin/saved-requests` — every saved request, newest first.
- `POST /__admin/saved-requests { name, instanceId, method, path, headers?, body?, expect?, collectionId? }`
- `POST /__admin/saved-requests/:id/send { expect? }` — send one **by id**.
  `expect` replaces the stored expectation for that call; `expect: null` checks
  nothing.
- `DELETE /__admin/saved-requests/:id`

[utils/request-store.js](./utils/request-store.js) owns the on-disk layout and is
the only thing that knows it: one `*.request.json` file per request under a
gitignored `requests/` directory (`IR_PROXY_REQUESTS_DIR` overrides it, for tests).

Not `state.json`, deliberately — that file is rewritten whole on every dashboard
action, so bodies in it would mean writing kilobytes on every mock toggle, and
its shape is one entry per host, which a saved request is not. They also hold
request headers, which is where `Authorization` lives; a file per request in an
ignored directory is where that stays contained.

**The id is a slug of the name; the display name lives inside the file.**
Decoupling them is what makes the filename safe — it is generated, never taken
from a client. Ids that arrive _from_ a client are checked against a strict
allowlist (`ID_RE`) rather than a `path.resolve` containment test, because that
check is the only thing between a `DELETE` and an arbitrary unlink. Saving runs
the same `validateRequestFields` a send does, so nothing unsendable can be
stored, and the name goes through `validateName` like every other label the
dashboard renders. There is no cache: this is read when the composer opens,
never on the request path.

**Sending by id exists so the payload is assembled once.** Four things need to
turn a saved record into a request on the wire — the dashboard's collection
runner, the CLI's `run`, and the three drop-in clients — and four hand-built
copies is how a newly added field silently stops being sent by three of them.
`expect` was exactly that field. The route also re-validates the stored
expectation rather than trusting it, because `requests/` is a directory somebody
can edit by hand.

There is still deliberately **no collection run endpoint**: order, progress and
Stop belong to whoever is watching the run, so every runner loops this route
itself.

An **expectation lives inside the request file**, as `expect`, because it is a
fact about that request: it survives an instance rename with the rest of the
record and needs no second store to go stale against. A request that has none
stores `null` rather than dropping the key, so a rename cannot quietly rewrite a
file into a different shape than a save does — and a file written before
expectations existed simply has no such key, which is why there is no migration.

### Collections

Named, **ordered** groups of saved requests, and the screen that runs them.

- `GET /__admin/collections` — `{ collections, ungrouped }`, ids already
  resolved into whole records, which is the shape the screen renders.
- `POST /__admin/collections { name }`
- `PATCH /__admin/collections/:id { name }` — renames without changing the id.
- `DELETE /__admin/collections/:id` — the group only; its requests survive,
  ungrouped.
- `POST /__admin/collections/assign { requestId, collectionId, index? }` —
  **every** membership change: add, move between groups, reorder inside one, and
  remove (`collectionId: null`). One route means one place the "a request
  belongs to at most one collection" rule is enforced.

[utils/collection-store.js](./utils/collection-store.js) holds nothing but names
and ordered id lists, in `_collections.json` beside the request files (the
underscore and the missing `.request.json` suffix keep `request-store.list()`
from picking it up). The requests themselves are never touched by any of it,
and that split is the design:

- **Order is the feature.** "Log in, then call the thing that needs the token"
  only works if position survives, which is what rules out a `collection` field
  on each request — a field expresses membership but not order, and an `index`
  field goes stale on the first insert.
- **Membership must stay cheap.** Moving a request between groups is metadata,
  and metadata should not rewrite a file holding a body and its headers.

`groupRequests` is pure and separately tested: it drops ids with no request
behind them, gives a double-listed id to the first group only, and calls
everything left over ungrouped — which is what every request saved before
collections existed already is, with no migration.

**There is no run endpoint.** Running a collection is the dashboard sending its
requests through `/send`, one at a time, in order. So a run inherits every
guarantee that route already makes, progress lands row by row as it happens, and
Stop is a local flag rather than server state nobody is watching. A run does not
survive closing the tab, which is the honest behaviour for something with a Stop
button.

### Blocking

[utils/blocking.js](./utils/blocking.js) is the **pure** rule — the same shape
and for the same reason as `interception.js`: it decides whether a request lives,
so it belongs somewhere a test can reach without a socket.

`createBlockMiddleware` sits **ahead of the mock middleware**, and the request it
matches is not answered — its socket is **destroyed**. That is deliberately not
what the neighbours do: `isActive: false` answers `503` and a mock can answer any
status, both of which are _responses_. A client that copes with a 503 has not
been shown what a service that is simply gone looks like, and killing the socket
is the one failure mode this proxy could not previously produce.

The rules live in `hostSettings[host].blocks` and persist in `state.json`; the
host is resolved from the **instance's configured target**, never from the
request, because on the standalone tier the `Host` header reads `localhost:3001`.

Because such a request never reaches `res.end`, the logger exposes `res.logAbort`
(see `createLoggerMiddleware`) — the block calls it before destroying the socket,
and the attempt lands in the log with `status: 0` and `source: "blocked"`. A
block that left no trace would be indistinguishable from a broken proxy.

Blocking is driven from three places, all through the same two endpoints: the
tree's context menu, the CLI (`block` / `unblock` / `blocks`), and the drop-in
**block clients** (`clients/{js,python,java}`). Every host-scoped response
carries `ssl`, because the rule runs inside the decrypted pipeline — with SSL off
the host is tunneled, the rule is stored, and nothing ever fires it. The CLI
declines to claim the path dies, and the clients throw; silently accepting a
block that cannot fire is the one way this feature lies to you.

### SSE multiplexing

[utils/sse-hub.js](./utils/sse-hub.js) owns the client set, the 30 s heartbeat
and frame formatting, so several producers share one `EventSource`. The naming
is load-bearing: **request entries are unnamed** (`data: …`), which is what
`onmessage` receives; **host updates are named** (`event: hosts`) and are
invisible to an `onmessage`-only client. That's what lets the two streams share
a connection without an older tab noticing.

## Host registry endpoints

- `GET /__admin/hosts` — every observed host, settings merged in.
- `POST /__admin/hosts/ssl { host, enabled }` — enabling promotes the host to an
  instance and returns its `instanceId`; disabling only clears the flag.
- `POST /__admin/hosts/focus { host, focus }` — `none` | `focus` | `ignore`.
- `POST /__admin/hosts/block { host, path, blocked }` — kill (or revive) a path.
  Rules are **prefixes**, so blocking `/orders` blocks `/orders/42` and pointedly
  not `/orders-archive`; `/` is matched exactly. Unblocking is exact — it lifts
  the rule that names the path, and the dashboard is what points the action at
  the rule actually in play. The response returns the whole list, because adding
  a broader rule collapses the ones it now covers.
- `GET /__admin/hosts/blocks` — what is blocked. Three shapes, because a client
  asks three different questions: no query returns every host that has rules as
  `{ host: [paths] }`; `?host=` returns that host's rules plus `ssl`; `?host=&path=`
  additionally answers `blocked` and names the `rule` that kills it. That last
  form exists so the prefix rule stays in **one** place — a CLI or test client
  evaluating it locally would be a third copy of `blockCovering` (after the
  backend and `tree-model.js`), free to drift from the one the proxy enforces.
  It reads `store.hostSettings` and **not** the host registry, which is the same
  data one indirection later: the registry is runtime-only and LRU-capped, and
  its eviction spares hosts with SSL or a focus but not hosts kept alive purely
  by a block rule — so a busy session could hide rules that are still killing
  requests.
- `DELETE /__admin/hosts/:host` — forget the host and its log entries. The
  instance and its mock toggles are kept.
- `GET /__admin/proxy/info` — local IPs, bound port, CA readiness, for the
  static setup page.

## Certificate lifecycle

[utils/cert-manager.js](./utils/cert-manager.js) (node-forge):

- `ensureCA()` — on first run generates a self-signed Root CA and writes
  `certs/ca.key` + `certs/ca.crt`; on later runs it loads them. Called once at
  startup. The certs dir is `certs/` by default, overridable with
  `IR_PROXY_CERTS_DIR` (used by tests).
- `getHostCert(hostname)` — lazily signs and caches a per-host leaf certificate
  used for the TLS handshake inside a MITM'd CONNECT tunnel.
- `getCACertPem()` / `getCACertDer()` — serve the CA for download
  (`.pem` for most platforms, `.cer` for iOS).

`certs/` is gitignored — the private CA key never leaves the machine.

## State model

[store.js](./store.js) is the in-memory source of truth:

- `instanceStatus[instanceId][mockName] = boolean` — per-instance mock toggles.
- `instanceSettings[instanceId] = { isActive, targetUrl, latency }` — `latency`
  adds N ms to every response of that instance (mock and proxied) to simulate
  slow networks; set from the host inspector, the CLI (`latency` command), or
  `POST /__admin/instance-settings`. `isActive: false` does **not** stop the
  proxy touching the host — it still decrypts and then answers everything with
  `503`, which is why the inspector labels that switch **"Fail all requests
  (503)"** (inverted: on = failing) rather than "off". The field name is
  unchanged for API compatibility.
- `hostSettings[hostname] = { ssl, focus, instanceId }` — the durable per-host
  preferences. `ssl` is what `shouldMitm` reads; `focus` picks the tree section.
  Only non-default entries are persisted (see
  [Per-host SSL proxying](#per-host-ssl-proxying)).
- `profiles` — named snapshots of `instanceStatus`.
- `standaloneInstances` — whether the direct per-instance servers are running.
- `proxyPort` — the port the unified proxy actually bound (runtime-only, set
  after `listen`; used by the replay endpoint, never persisted).

### state.json

**The runtime shape and the file shape are different on purpose.** Above, a
host's facts sit in four slices keyed two different ways — `hostSettings` by
hostname, the rest by instance id. That suits the code, where every consumer
reads exactly the slice it needs, and reads terribly: understanding one host
means cross-referencing four sections by hand.

So the file uses the other shape, one entry per host:

```json
{
  "version": 2,
  "proxy": { "standalone": false },
  "instances": [
    {
      "id": "api",
      "name": "My API",
      "host": "api-qa.example.com",
      "upstream": "https://api-qa.example.com",
      "port": 3000,
      "ssl": true,
      "mocks": { "Account Locked": true }
    },
    { "host": "ads.example.com", "focus": "ignore" }
  ],
  "profiles": {}
}
```

[utils/state-store.js](./utils/state-store.js) is the **only** code that knows
this layout: `load` fans it out into the slices, `save` folds them back, and
`server.js` works in slices either side. Notes that matter:

- **`host` and `upstream` are different fields.** `host` is what gets
  intercepted; `upstream` is where unmocked requests are forwarded, and is
  editable from the inspector. Seeding them identical is a default, not an
  invariant.
- **An entry has an `id` if and only if it is an instance.** Ones without exist
  purely to remember a `focus` — the "ignore this CDN" case.
- **Defaults are omitted on write** (`latency: 0`, `isActive: true`,
  `focus: "none"`), and entries are sorted deterministically, so the file stays
  scannable and doesn't reshuffle on every save.
- A pre-v2 file is migrated on first load, keeping the original as
  `state.json.v1.bak`. Port and name for the old `config.js` targets are
  recovered from `state.example.json`, which is where that block went — for a
  checkout that has put its own entries there. The shipped seed is empty, so by
  default a migrated instance falls back to its hostname and a freshly allocated
  port rather than to an invented name.

`state.json` is gitignored runtime state; `state.example.json` is versioned and
is copied over on first boot.

The **CLI** ([scripts/cli.js](./scripts/cli.js)) talks to these same
`/__admin` endpoints. It has no hardcoded port: it auto-detects the live proxy
by scanning `config.proxy.preferredPort … +20` and verifying `/__admin/health`
identifies our server (so another proxy on 8888 is skipped). `MOCK_PORT` /
`MOCK_HOST` override the discovery.

## Dynamic instances

`config.js` declares no targets at all; every one of them comes from
`state.json`. The dashboard can **add, rename and remove intercepted instances at
runtime** (`POST` / `DELETE /__admin/instances`,
`POST /__admin/instances/:id/rename`), without a restart. This works because the
`serverConfigs` array is shared **by reference** through `server.js` →
`proxy-server.js` → every `createAdminRouter`,
and the proxy resolves targets by reading it **live on every request**
(`resolveInstance`). Pushing/splicing an entry therefore changes what's
intercepted immediately; `getInstanceApp` lazily builds the new instance's app
on its first hit, and `cert-manager` mints its per-host leaf cert on demand.

The portable logic lives in
[utils/instance-manager.js](./utils/instance-manager.js) (`createImpl` —
validation, unique-id slug, port allocation, mutating `serverConfigs`/`store`,
persistence). `server.js` injects the side effects (`initInstanceState`,
`saveState`, evicting cached apps, reconciling the standalone tier) and registers
it through the `configure()` mediator — the same one-directional pattern as
`standalone-manager.js`. Every instance is removable now that `config.js` fixes
none. The assigned `port` is for the optional standalone server; the unified
proxy intercepts by host regardless.

`allocatePort` hands out the **lowest free port at or above 3000**, not
`max + 1`. Hosts get promoted and dropped freely now that enabling SSL allocates
one, and a high-water mark would climb away from the range the developer has
holes punched for while never reusing the gaps behind it.

**Renaming re-keys four things and rewrites disk.** `renameInstance` moves
`instanceStatus`, `instanceSettings` and every `hostSettings[*].instanceId`; the
route around it also rewrites the `servers: [...]` scopes inside `.mock.js` files
(via `setMockServers`), re-keys the live request log and capture sessions, and
evicts the cached instance app — whose logging middleware and mock pipeline both
closed over the old id, and which would otherwise keep writing it. Every file
rewrite is computed and validated before the rename is committed, so a
transform that can't be applied aborts with nothing changed.

## Mock loading & hot-reload

[utils/mock-loader.js](./utils/mock-loader.js) recursively loads every
`*.mock.js` under `mocks/`, normalizes `name`/`file`/`folder`, and caches the
result. An `fs.watch` (unref'd) invalidates the cache when a mock file changes;
`loadMocks.invalidate()` is also called after admin CRUD operations, giving
hot-reload without a restart.

A mock module exports an object (or array of objects):

```js
module.exports = {
  name: "Account Locked",
  delay: 0, // optional latency (ms)
  match: (req) => req.path === "/account/authenticate" && req.method === "POST",
  respond: (req, res) => res.status(403).json({ error: "locked" }),
  // optional: interceptResponse + transform(json, req) to rewrite a real response
};
```

## Frontend

Static assets in `public/` are served by both tiers (the proxy serves them at
its root). The dashboard is a **two-pane traffic workspace** and is
**desktop-only**: a host tree on the left, the inspector on the right, with a
draggable divider between them and a second one inside the right pane.

```
┌─ app bar ─────────────────────────────────────────────┐
├─ host tree ──┬┬─ hits table for the selected node ────┤
│ ★ Focused    ││                                       │
│ ▾ 🔒 host    │├──────── horizontal splitter ──────────┤
│    ▾ v1      ││ [ Request | Response ]                │
│      offers  ││   Query · Headers · Body (jsontree)   │
│   All hosts  ││                                       │
│   Ignored    ││                                       │
└──────────────┴┴───────────────────────────────────────┘
   --pane-left  ↕  --pane-hits
```

Panes are CSS grid tracks sized by custom properties (`--pane-left`,
`--pane-hits`). A drag writes exactly one value on the grid container, so the
grid reflows and **nothing re-renders** — the tree keeps its scroll position and
selection mid-drag. Sizes persist to `localStorage["ir-proxy.panes"]` and are
restored by a small inline script in `<head>`, before first paint, to avoid a
visible jump.

| File             | Responsibility                                                       |
| ---------------- | -------------------------------------------------------------------- |
| `state.js`       | Shared mutable `state` object + constants                            |
| `util.js`        | `getApiUrl`, `api`, `toast`, confirm modal                           |
| `certs.js`       | OS detection, CA download button, install-guide modal                |
| `editor.js`      | Ace editor, mock-file CRUD, drag-and-drop                            |
| `jsontree.js`    | Collapsible JSON renderer (real DOM, never `innerHTML`)              |
| `tree-model.js`  | **Pure**: entries + hosts → the nested tree. Unit-tested             |
| `entries.js`     | SSE transport (both channels), history, host mutations               |
| `hosts.js`       | Left panel: tree render, selection, right-click menus                |
| `inspector.js`   | Right panel: overview, hits table, detail, search, cURL, create-mock |
| `collections.js` | Collections view: groups, drag-to-reorder, the sequential runner     |
| `splitter.js`    | Reusable pointer-driven pane resizing                                |
| `contextmenu.js` | One reusable right-click menu                                        |
| `dashboard.js`   | Entry point: config load, mocks views, popovers, health, keyboard    |

There is **no build step** — the browser loads native ES modules
(`<script type="module">`). `public/package.json` declares `"type": "module"` so
Node and Jest read those files as ESM too; browsers ignore it.

**Two event conventions coexist, deliberately.** The surviving modals and the
mock matrix keep inline `onclick`, which resolves against `window` — the entry
module binds every exported handler there, and leaf-to-entry up-calls go through
`window.load()` to keep the import graph acyclic. The tree and inspector instead
use **one delegated listener per panel root**, dispatching on `data-*`. They have
to: `contextmenu` can't be expressed as an inline attribute carrying node
identity, and they render hostnames and paths that arrive from the network —
those go through `textContent`/`dataset`, never an interpolated HTML string.
`jsontree.js` set that precedent for the same reason.

**Tree modelling.** A leaf is a **path, not a call**: an endpoint polled 200
times is one row badged `×200`, and the individual calls are listed in the
inspector's hits table. The previous log tree made a sibling node per request,
which is why it collapsed under load. Hosts sort alphabetically, never by
recency — the tree re-renders on every batch of live traffic, and recency
ordering makes rows jump out from under the pointer.

### Mobile and tablets

The dashboard needs a desktop-sized screen, so phones and tablets are redirected
to `public/install-guide.html` — a self-contained certificate-setup page that
reads the real proxy IP/port from `GET /__admin/proxy/info`, leads with the
visitor's own OS, and offers a "check it worked" button.

Detection happens twice on purpose: server-side on `/` (registered _before_
`express.static`, which would otherwise answer with `index.html`) using
`sec-ch-ua-mobile` and the user agent, and again client-side in `index.html`,
because **iPadOS 13+ sends a desktop macOS user agent** and only
`navigator.maxTouchPoints` gives it away. A desktop user at a narrow window is
_not_ redirected — they get a dismissible overlay instead. `?desktop=1` overrides
both, persisted in `sessionStorage`.

## Trust boundaries

Worth stating plainly, because two of these are easy to forget when adding code.

**The network is trusted, by design.** The proxy binds `0.0.0.0` and `/__admin`
has no authentication, so every admin route — including `log-history`, which
holds captured `Authorization` headers and bodies — is readable and writable by
anyone who can reach the port. See the Security Note in
[README.md](./README.md#️-security-note) for the consequences and for the shape
a fix would take. Anything added under `/__admin` inherits this exposure.

**Hostnames are attacker-controlled input.** Before the host registry existed,
every host in the UI came from `config.js`, so interpolating one into markup was
safe. Now a host is whatever a device asked the proxy for. Three consequences:

- The tree and inspector build DOM and assign `textContent`/`dataset`; they
  never interpolate a hostname or path into an HTML string. `jsontree.js` set
  this precedent for response bodies and it now extends to hostnames.
- `toast()` builds its DOM rather than using `innerHTML`, because toasts carry
  hostnames and server error messages that quote them. Escaping at the call
  site would work until someone adds a call site and forgets.
- `ensureInstanceForHost` screens the host with the same `UNSAFE_NAME` check
  `addInstance` applies to a user-typed name: the promoted instance takes the
  hostname as its display name. `new URL()` alone is not that check — it rejects
  `<` and `>` but passes `"` and `=`.

Node's HTTP parser rejects `<`, `>` and backtick in a CONNECT request target, so
those never reach the registry from the wire — but that is the parser's guarantee,
not this codebase's, and it says nothing about the admin API's JSON bodies.

**Bounded state.** Everything that grows from traffic has a ceiling, and it's
worth keeping that true: the request log (`MAX_LOG_SIZE`, bodies at
`MAX_BODY_CHARS`), capture sessions (`MAX_ENTRIES_PER_SESSION`,
`MAX_FINISHED_SESSIONS`, `MAX_ACTIVE_SESSIONS`), the host registry
(`MAX_HOSTS`, LRU, never evicting a host with SSL on or focused), and SSE
clients (evicted on backpressure). The proxy's per-instance app cache is the one
that isn't self-limiting — it's cleared explicitly through `evictInstanceApp`
from `instanceManager`'s `onRemoved` hook.

## Testing

[Jest](https://jestjs.io/) + [supertest](https://github.com/ladjs/supertest) in
`tests/`:

- Unit: `interception` (the MITM predicate + the seeding migration — this is the
  suite that protects every existing mock from the SSL flip), `host-registry`,
  `sse-hub`, `mock-loader`, `cert-manager` (against a temp `IR_PROXY_CERTS_DIR`),
  `request-log`.
- Integration: an Express app assembled from the real factories asserts mock
  responses, toggling, log capture, `/config`, the `/hosts` surface, and the
  `safePath` traversal guard.
  `tree-model.js` builds **one node per path**, and settles `kind` only once the
  whole host has been walked: a path that is both an endpoint and a prefix
  (`/service-status` with `/service-status/123` under it) is a single node that
  carries its own calls _and_ children. Splitting it into a folder and a leaf gave
  the two the same id, and since a selection is an id, only one of them could ever
  be opened.

- Frontend: `tests/tree-model.test.mjs` covers the tree grouping and the
  focus/ignore partition — the frontend logic most likely to be quietly wrong.
  It is `.mjs` because it imports the dashboard's ES modules; the `test` script
  passes `NODE_OPTIONS=--experimental-vm-modules` for Jest's ESM support. Panels,
  splitters and menus are verified manually in the browser.

`tests/instances-api.test.js` must keep passing untouched — its `409 on a
duplicate target` assertion is the regression alarm for `addInstance`, which
`ensureInstanceForHost` must never relax.

Run `npm test`. Lint/format with `npm run lint` and `npm run format`.
