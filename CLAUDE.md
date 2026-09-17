# CLAUDE.md

Orientation for AI assistants and new developers working in this repo. Keep it
short; deeper detail lives in [ARCHITECTURE.md](./ARCHITECTURE.md).

## What this is

An intercepting **mock proxy** for QA and local development. It records every
host the connected devices reach for, decrypts the ones you explicitly enable,
serves canned responses for them, and turns captured requests into mocks. The dashboard is a two-pane workspace: a host tree on the left, an
inspector on the right, both resizable.

**It is desktop-only.** Phones and tablets are redirected to
`public/install-guide.html`, a certificate-setup page for their OS.

## Commands

```bash
npm run dev          # start with auto-reload (nodemon)
npm start            # start once
npm test             # Jest + supertest
npm run lint         # ESLint (must pass)
npm run format       # Prettier (writes)
npm run mock:status  # CLI: per-instance status
```

## Where things live

- `config.js` — the proxy's own settings, and nothing else. **No targets.**
- `state.json` — every host/instance, one entry each. The only source of
  targets; gitignored, seeded from the versioned `state.example.json` on first
  boot.
- `server.js` — boots the proxy; also starts the optional per-instance Express
  servers (`:3000/:3001/:3002`), which are off by default
  (set `STANDALONE_INSTANCES=1` to enable).
- `proxy-server.js` — the unified MITM proxy + dashboard host (`:8888`→`:8889`).
  Per-instance apps are built once and cached (`getInstanceApp`).
- `utils/` — `interception` (the **pure** MITM predicate), `blocking` (the
  **pure** "does this path die?" rule), `state-store` (the
  only code that knows state.json's layout), `host-registry` (every host a
  device reaches for), `sse-hub` (one SSE connection, several channels),
  `mock-pipeline`, `request-log`, `mock-loader`, `cert-manager`,
  `instance-manager`, `request-store` (saved composer requests),
  `collection-store` (ordered groups of those; `groupRequests` is the **pure**
  "what does the screen show?" rule), `mock-conflicts` (the **pure** "do these
  two mocks fight?" rule), `schema-validate` (the **pure** "is this response the
  right shape?" rule), `schema-store` (those schemas as files in `schemas/`),
  `template` (the **pure** "what does `{{ this }}` stand for?" rule).
- `utils/admin-router.js` + `utils/admin/` — every `/__admin/*` endpoint, one
  module per domain. The router file owns only the shared context and the mount
  order; see its header for the rule about what may live there.
- `mocks/` — `*.mock.js` definitions (grouped in subfolders). **Contents
  gitignored**, directory tracked: the mocks in a checkout are whatever that team
  is mocking, and committing them would hard-wire one QA environment into a tool
  meant to be dropped into any project. Same `mocks/*` + `!mocks/.gitkeep` shape
  as `requests/*`, and for the same git reason (the bare form is never
  descended into, so the negation would not apply).
- `schemas/` — `*.schema.json`, plain JSON Schema and nothing else. **Committed**,
  unlike `requests/`. Both directories are tracked via a `.gitkeep` so a fresh
  clone has somewhere to save into; `requests/` ignores its _contents_
  (`requests/*`, which is why the star is there — git won't descend into a
  directory ignored by the bare form, so the `!requests/.gitkeep` negation only
  works written that way).
- `public/` — the desktop dashboard (ES modules under `public/js/modules/`,
  orchestrated by `public/js/dashboard.js`) plus `install-guide.html`, the
  static certificate-setup page phones and tablets are sent to. **One module per
  panel**: `hosts` (tree), `inspector`, `mocks` (the matrix), `collections`
  (saved requests, grouped and runnable), `request-editor`, `editor` (mock
  files), `access`, `certs`, plus `panel-search` (find-in-panel, which the
  inspector configures with a section resolver rather than owning).
  `dashboard.js` keeps only what belongs to no panel — config loading, the
  health badge, profiles, the header popovers, the shortcuts — and the `window`
  bindings that join them.
- `clients/` — drop-in QA helpers, **one file per language, zero deps**:
  `capture` (assert on what the app sent), `mock` (stage a toggle), `block`
  (make a service die), `schema` (run the saved requests and assert the answers).
  The first three stage a condition; the last asserts an outcome. They are copied into other repos, so each one carries
  its own port autodetection instead of sharing — the duplication is the point.
- `scripts/cli.js` — the whole CLI, one `cmdX` per command.
- `docs/ROADMAP.md` — known holes that were **measured and deliberately left**,
  each with the evidence that produced it. Check it before concluding something
  is broken by accident, and add to it rather than dropping a `TODO` in the code.
  Today: binary/multipart request bodies (binary is silently corrupted), filters
  on non-variable body fields, response header case, and the 1 MB ceiling on
  schema expectations — plus a reference section with every body-size limit
  measured, where each constant lives, and what raising it costs.
- `tests/` — Jest unit + supertest integration tests.

## Conventions

- Backend is CommonJS; `public/js` is native ES modules (no build step).
  `public/package.json` carries `"type": "module"` so Node and Jest read those
  files as ESM — browsers ignore it.
- Prettier owns formatting (`.prettierrc`); run `npm run format`, don't
  hand-format. ESLint config is `eslint.config.js` (flat).
- **Two event conventions, on purpose.** The surviving modals (editor, confirm,
  scope, install guide, shortcuts) and the mock matrix (`modules/mocks.js`) keep
  inline `onclick`, which resolves against `window`; the entry module auto-binds
  every exported handler, and cross-module up-calls go through `window` —
  `load`, `render`, `closeSettings` — to stay acyclic. **Moving a handler
  between modules means checking that binding list**: miss it and the button
  silently does nothing, which no test here catches.
  The **host tree and inspector** instead use one delegated listener per panel
  root, dispatching on `data-*`. They must: `contextmenu` can't be an inline
  attribute carrying node identity, and they render hostnames and paths that
  come off the wire — those go through `textContent`/`dataset`, never into an
  interpolated HTML string.
- Frontend tests are `.mjs` (`tests/tree-model.test.mjs`) because they import
  those ES modules. **Keep pure logic where a test can reach it** —
  `tree-model.js`, and `panel-search.js`'s `searchPattern`/`markMatches`, which
  were untestable while they sat inside a DOM-driven module. That is also the
  reason `util.js` reads `globalThis.navigator` rather than the bare global: it
  is imported in plain Node by those tests.
- Keep changes lint-clean and tested; verify UI changes in the browser.

## Gotchas

- **Port 8888** is often already held by another debugging proxy, so the
  proxy/dashboard usually lands on **8889** (printed at startup). The dashboard
  is served by the **proxy** at its root. The `:3000/:3001/:3002` instance
  servers are **off by default** — enable them at runtime from the dashboard
  header toggle, `npm run mock -- standalone --on`, or at boot with
  `STANDALONE_INSTANCES=1`. The choice is persisted in `state.json`.
- **SSL proxying is per host, and off by default.** The proxy decrypts a host
  only when `store.hostSettings[host].ssl` is true (`utils/interception.js`
  `shouldMitm`) — everything else is tunneled untouched and merely _recorded_.
  Turn it on from the tree's right-click menu.
- **The runtime shape and the file shape are different on purpose.** At runtime a
  host's facts sit in four slices keyed two ways: `hostSettings` by hostname,
  `instanceStatus`/`instanceSettings`/`serverConfigs` by instance id. On disk
  they fold into one entry per host. `utils/state-store.js` is the only code that
  knows this; everything else works in the slices. Change the layout there and
  nowhere else.
- **`host` and `upstream` are not the same field.** `host` is what gets
  intercepted (`resolveInstanceForHost` matches on it); `upstream` —
  `instanceSettings[id].targetUrl` at runtime — is where unmocked requests get
  forwarded, and is editable from the inspector. Seeding them identical is a
  default, not an invariant: pointing them apart is how you intercept prod and
  answer from QA.
- **Blocking kills the connection; it does not answer.** `hostSettings[host].blocks`
  holds path **prefixes** (`utils/blocking.js`), and the middleware sits **ahead
  of the mocks and the 503 switch** (`createBlockMiddleware`) because a block is
  not a response — a mock answering first would make the service look alive, and
  a block is the more specific instruction anyway. That ordering is the feature:
  `isActive: false` already gives you a 503 and a mock gives you any status, so
  destroying the socket is the one failure this proxy could not otherwise
  produce. One prefix rule covers both things the tree offers it on, since
  blocking the folder `/orders` and blocking the endpoint `/orders` are the same
  request; `/` is matched exactly, because in the tree it is a leaf beside the
  other paths and not their parent. The host comes from the instance's target,
  **never** from the request — on the standalone tier the `Host` header reads
  `localhost:3001` and every rule would quietly stop matching.
- **A block rule on a host with `ssl: false` is stored and inert**, because the
  middleware lives inside the instance app and a tunneled host never reaches it.
  That is invisible from the dashboard (you can only right-click a path on a host
  you already decrypted) but wide open to the CLI and the clients, which can name
  any host. So every host-scoped block response carries `ssl`: the CLI declines
  to say the path dies, and the clients throw. Silently accepting a block that
  cannot fire is the one way this feature lies to you.
- **`GET /__admin/hosts/blocks` reads `store.hostSettings`, never the registry.**
  The registry looks like the same data one indirection later, but it is
  runtime-only and LRU-capped, and `_evict` spares hosts with SSL or a focus and
  **not** hosts kept alive purely by a block rule — the one case `state-store.js`
  goes out of its way to persist. A read that reported nothing while the block
  was still killing requests is worse than no read at all. Its `?host=&path=`
  form answers "would this die, and which rule kills it" **server-side**, so the
  prefix rule stays in one place: the CLI and all three clients ask rather than
  re-deriving it, which would have made a third copy of `blockCovering` after the
  backend and `tree-model.js`.
- **A killed request never reaches `res.end`, so the logger has `res.logAbort`**
  (`utils/request-log.js`). Without it the one request you most want to see is
  the one that vanishes, and "did my block fire?" is the only question anyone
  asks of the feature. It records with `status: 0` and `source: "blocked"`, and
  is guarded against firing twice because a dying socket can reach both paths.
  Blocked rows are badged **BLOCK**, and that tag **replaces** the source and
  status badges rather than joining them — otherwise the row describes a call
  that can no longer happen, and once a blocked call is logged it reads BLOCK
  twice. The tree renders source badges through `srcLabelFor` for the same
  reason: uppercasing the raw source spelled states two ways across panels
  (`SERVER-OFF` against `OFF`).
- **The tree is one node per path, and `kind` is derived last**
  (`public/js/modules/tree-model.js`). `/service-status` and
  `/service-status/123` are an endpoint and its child, so the first is a single
  node that both holds its own calls and has children — it renders with a
  twisty _and_ method/status badges, and its context menu is the leaf one.
  Building a separate folder and leaf for that path is what produced two rows
  carrying the **same id**, and since a selection is an id, whichever
  `findNode` reached first won and the other could never be opened. So a folder
  may have `entries`, `collectEntries` asks every node for its own and not just
  the leaves, and nothing decides folder-vs-leaf while walking: a path can be
  hit directly long before the request that gives it a child arrives.
- **A host IS an instance.** Enabling SSL on a discovered host promotes it via
  `ensureInstanceForHost`, because everything downstream (logging, mock scoping,
  `isActive`, latency) is keyed by `instanceId`. Disabling SSL only clears the
  flag and stops the standalone listener; it keeps the instance **and its port**,
  so the host comes back on the same one. It must **not** remove the instance, or
  every mock toggle for that host goes with it.
- **An entry has an `id` if and only if it is an instance.** Entries without one
  exist purely to remember a `focus` — the "ignore this CDN" case. Everything
  else about a host nobody acted on is runtime-only (`utils/host-registry.js`,
  LRU-capped), because browsing through the proxy surfaces hundreds of CDN hosts
  and `state.json` would grow without bound.
- **Renaming an instance id has to rewrite the mock files.** Mocks scope
  themselves by hand (`servers: ["api"]`), so a rename that misses them detaches
  those mocks silently — still enabled, matching nothing. The rename endpoint
  computes every rewrite before committing to any of it, and evicts the cached
  instance app, whose logging middleware closed over the old id.
- `isActive: false` is **not** "off" in the new model — it still decrypts and
  answers `503`. `ssl: false` is the one that means "don't touch this host".
  The inspector therefore labels that switch by its effect —
  **"Fail all requests (503)"**, inverted so on = failing — instead of putting
  two switches meaning opposite things next to each other, both reading "off".
  Keep the API field named `isActive`.
- Hosts in `hostSettings` are seeded into the registry at boot
  (`hostRegistry.ensure`), so a configured host shows in the tree with zero
  counters instead of being invisible — and therefore unconfigurable — until
  something happens to hit it.
- **Instances can still be added explicitly** (`POST /__admin/instances`, or the
  settings popover); that seeds `ssl: true`, since typing a target in means you
  want it intercepted. All instances are removable now that `config.js` declares
  none. Removing a host removes the instance behind it, mock toggles included —
  the tree's confirm dialog says how many.
- **`--var name=value` is the CLI's only repeatable flag** (`REPEATABLE` in
  `scripts/cli.js`), an allowlist rather than making every flag an array —
  last-one-wins is right for `--instance` and the rest, and changing that
  globally to fix one would quietly alter all of them. It splits on the **first**
  `=` only, because a value routinely contains one (a base64 credential ends in
  them). Unlike `--schema-file`/`--status` it is **not** restricted to a single
  `--request`: a schema is a statement about one specific response, a variable is
  an input the whole flow needs. Whether a name is usable stays
  `utils/template.js`'s call — the CLI carries no second copy of that rule.
- The **CLI auto-detects the proxy port** (scans `preferredPort…+20`, verifying
  it's our server), so `npm run mock -- …` works without `MOCK_PORT`. Override
  with `MOCK_PORT`/`MOCK_HOST` if needed.
- `state.json`, `state.json.v1.bak` and `certs/` are gitignored runtime
  artifacts. `state.example.json` is versioned and is what a fresh clone boots
  from — and it seeds **no instances**, because which hosts are worth
  intercepting is a fact about the project under test, not about this tool. A
  clone starts inert and fills its tree from real traffic.
- **`/__admin` is mounted whether or not there are instances**
  (`proxy-server.js`). It used to be guarded by `if (serverConfigs[0])`, which
  was invisible while the seed shipped targets and fatal once it stopped: the
  static handler still serves the dashboard's HTML, so the page comes up and
  then 404s every call it makes — no tree, no config, and no way to add the
  instance that would bring the API back. Zero instances is now the **normal**
  first run and also what removing your last host leaves you with. `serverConfigs`
  is read live per request, so one router serves instances added later too;
  `instanceId` is only `/config`'s `currentInstanceId`, and `null` is the honest
  answer when there is no column for the matrix to highlight.
  `tests/empty-state.test.js` holds this down.
- **This machine's LAN address is watched, not assumed** (`utils/network-watch.js`,
  polled — Node has no portable "network changed" event). A router reboot hands
  out a new lease and every device's proxy settings silently point at nothing, so
  the boot banner is reprinted and a named `network` SSE frame updates the
  dashboard. Compare addresses as a **sorted set**: interface enumeration order
  isn't stable, and a reshuffle reported as a change is noise that buries the
  real one. It is also the single source of `localIPs` — `/proxy/status`,
  `/proxy/info` and the banner all used to compute it themselves.
- **Mock hit counts are runtime-only and independent of the activity log**
  (`utils/mock-stats.js`, fed by the same `requestLog.onEntry` hook as the host
  registry). Tying them to the log would delete the evidence that a mock fired
  after 1000 requests — exactly when someone is asking. Clearing the log leaves
  them; `reset()` is separate. They follow a rename and die with their instance.
- **Ace's theme is a second lazy module**, landing about a second after the core
  it comes with — so between an editor appearing and monokai arriving, Ace
  paints in its default _light_ theme, a full-height white flash inside a dark
  modal. Both mount points (`#code-editor`, `.replay-editor`) wear `--ace-bg`
  from the start so the un-themed window looks like the themed one. That token
  is monokai's own background: it tracks the `ace/theme/monokai` in `editor.js`
  and `request-editor.js`, not the palette it sits next to.
- **No native `prompt()`/`alert()`.** They block the renderer — the create-mock
  one froze the tab outright — and can't validate. Use `showPrompt`
  (`public/js/modules/util.js`), whose `validate` runs per keystroke and can
  return a string (blocks) or `{ warning }` (shows, doesn't block; an overwrite
  is a legitimate thing to want). Mock paths go through `validateMockPath`
  (`editor.js`), which also catches collisions against the loaded mock list.
- **A truncated body has to be copied out of the original, not sliced from it**
  (`_detach` in `utils/request-log.js`). `str.slice()` in V8 is a _view_ onto its
  parent, which stays alive as long as the view does — so cutting a body to
  `IR_PROXY_BODY_CHARS` kept the whole upstream response. Measured on the real proxy
  path: 300 × 8 MB responses cost **2.4 GB** of heap while `stats()` truthfully
  reported 75 MB, because it counts what was _stored_ and the cost was in what
  was still _referenced_. The tell is that raising or lowering the cap barely
  moved the number — the setting was not what you were paying for. With the copy
  it is 75 MB, and doubling the cap doubles it and nothing else.
  `captureChunk` is the other half: it stops at `MAX_CAPTURE_BYTES` and now
  **clips** the chunk it takes rather than only deciding whether to take the
  next one — on the proxy path `responseInterceptor` delivers the entire body as
  a _single_ chunk, so the old rule declined nothing and the cap was inert for
  every proxied response. That bound is `3 × MAX_BODY_CHARS` because the cap
  counts UTF-16 units and UTF-8 spends at most three bytes on one: enough to
  always overshoot the character cap, which is what keeps `truncated` tripping.
  The memory test for this runs in a **child process** — `heapUsed` inside a Jest
  worker moves with whatever else that worker has been doing.
- **The activity log is where the memory goes**, and `IR_PROXY_LOG_SIZE` /
  `IR_PROXY_BODY_CHARS` tune it (`utils/request-log.js`). Raising the first is not
  free: the hits table renders from the log, so the real cost is the DOM, not the
  heap. `requestLog.stats()` reports an estimate tracked incrementally —
  recomputing would mean re-serialising every retained body, and the dashboard
  asks on a timer. Pausing (`setPaused`) retains nothing, broadcasts nothing and
  runs no `onEntry` listeners; traffic and mocks are unaffected.
- **Socket error handlers are `on`, never `once`.** A TLS socket can error more
  than once — the MITM handler destroys the socket under it, which is itself a
  way to provoke a second — and an `'error'` with no listener throws, taking the
  whole proxy down. `server.js` has last-resort process guards, but they only
  shrug off dead-socket codes; anything else exits non-zero on purpose.
- **A machine that isn't this one has to be approved before it can use
  `/__admin`** (`utils/access-gate.js`). Its request is held until somebody
  answers in the dashboard, or 60s passes. The one invariant: **only loopback can
  grant access.** `/__admin/access/*` therefore sits _outside_ the gate
  (`UNGATED` in `proxy-server.js`) and enforces loopback itself — routed through
  the gate instead, a remote caller asking to approve itself would surface as an
  ordinary prompt somebody might click. Approval is per **machine**, so a
  dashboard's parallel XHRs share one prompt. The certificate routes stay open or
  a phone could never reach the point of asking. `X-Forwarded-For` is never read.
- **Anything a client can name goes through `validateName`**
  (`utils/instance-manager.js`) and is rendered as **DOM text, never markup**.
  Instance names and profile names both qualify. The profile chips are built as
  nodes with a delegated listener for exactly this reason — an interpolated
  `onclick` there was the dashboard's one stored-XSS hole.
- There is **no "record" feature** anymore — right-click a leaf in the tree and
  choose **Create mock**, or use the inspector's Create Mock button.
- **One request editor, two modes** (`public/js/modules/request-editor.js`):
  Retry starts from a captured entry with the host fixed, New Request starts
  empty with the host as a picker. They share a module because they are the same
  editor — splitting them would mean two copies of the Ace wiring drifting
  apart. Its DOM ids are still `replay-*`; they predate compose mode and
  renaming them would churn ~50 lines of markup and CSS for no behaviour change.
- **A composed request goes through the proxy, never straight upstream**
  (`sendViaProxy` in `utils/admin-router.js`, shared with replay). That is the
  entire reason this feature belongs here rather than in Postman: mocks,
  latency and the 503 switch all apply, and the call lands in the same log as
  the device traffic. Keep the `409` when SSL is off for the target — sending
  anyway would tunnel it upstream with nothing mocked and nothing logged, which
  is not what the button says it does. The target host is derived from the
  instance and must **never** become a caller-settable field.
- **Saved requests are files, not `state.json`** (`utils/request-store.js`,
  gitignored `requests/`). state.json is rewritten whole on every dashboard
  action, so bodies in it would mean writing kilobytes on each mock toggle — and
  it is one entry per host, which a saved request is not. They also store
  headers, and headers store `Authorization`; a file per request in an ignored
  directory is where that is contained. **The id is a slug of the name and the
  display name lives inside the file** — that decoupling is what makes the
  filename safe, since it is generated and never taken from a client. Ids
  arriving from a client are still checked against `ID_RE` before touching the
  filesystem: that check is the only thing between a `DELETE` and an arbitrary
  unlink. Saving is validated with the _same_ `validateRequestFields` a send
  uses, so nothing unsendable can be saved.
- **A collection holds ids, never requests** (`utils/collection-store.js`,
  `requests/_collections.json`). Order is the feature — "log in, then call the
  thing that needs the token" — which is what rules out a `collection` field on
  each request: a field carries membership but not position, and an `index`
  field goes stale on the first insert. Keeping the group to names and ids also
  means moving a request between collections doesn't rewrite the file holding
  its body and headers. `assign` is the **only** mutation (add, move, reorder,
  and remove are one operation with different arguments), which is where "a
  request belongs to at most one collection" is enforced; `groupRequests`
  enforces it again on read, because the file is hand-editable and a request
  listed twice would be **run** twice. Anything unlisted is ungrouped — which is
  what every request saved before collections existed already is, so there is no
  migration.
- **The full-pane views own the buttons that act on them.** "+ New Mock" lives
  in the mock matrix's header, "→ New request" in the collections one; the app
  bar keeps only what is global. It had grown a row of actions belonging to
  screens you were not looking at. The `⌘⌥N`/`⌘⌥R` shortcuts stay global — they
  open modals, not views.
- **Dragging a request needs a position, not just a destination**
  (`public/js/modules/collections.js`). The mock matrix's drag only has to name
  a folder; here the order is what a run follows, so the top/bottom half of the
  hovered row decides the index. `assign` removes before it places, so an index
  measured with the row still in the list is one too high when it moves **down**
  inside its own group — corrected on the client, which is the only side that
  knows both positions. _Ungrouped_ is therefore always rendered, even empty:
  it is where a drag out of a collection lands.
- **Running a collection is client-side on purpose** (`public/js/modules/collections.js`).
  It is `/send` in a loop, in order, awaiting each — so it inherits that route's
  guarantees, progress lands row by row, and Stop is a local flag instead of
  server state nobody is watching. A run dies with the tab, which is the honest
  behaviour for something with a Stop button. Adding a server-side runner would
  buy runs that outlive the dashboard, and nothing else.
- **Renaming an instance has to repoint saved requests too**, for the same
  reason it rewrites mock files — they are scoped by instance id, and a rename
  that skips them leaves them listed but unsendable
  (`requestStore.renameInstance`, alongside the log/capture/mock-stats calls).
- **The response body is buffered only when there is an expectation to read
  it.** A saved request may carry `expect: { status?, schema? }`, checked in
  `sendViaProxy`; with none, that function keeps the `upstream.resume()` drain
  it has always had, so a collection of unchecked requests costs exactly what it
  did before. This is also why the check is **server-side**: the untruncated
  body exists nowhere else — by the time the dashboard could read one,
  `request-log.js` has cut it to `IR_PROXY_BODY_CHARS`, and half a JSON document
  does not parse. Past 1 MB it reports that it could not check rather than
  validating a fragment, the same call replay makes on a truncated request body.
  `ok: true` still means "it went out and came back": a failed expectation is a
  **successful send of a request whose answer was wrong**, which is why the row
  reads `200 ✗` instead of putting a red X where the status goes.
- **A saved request is sent by id, and the payload is assembled in exactly one
  place** (`POST /__admin/saved-requests/:id/send`). Four callers need it — the
  dashboard's collection runner, the CLI's `run`, and the three clients — and
  four hand-built payloads is how a field added to a saved request quietly stops
  being sent by three of them. `expect` was that field: it had to be threaded
  through `collections.js` by hand, and the clients did not exist yet to be
  missed. `{ expect }` in the body **replaces** the stored one, which is what
  lets a suite keep schemas in its own repo; the route re-validates the stored
  one rather than trusting it, since `requests/` is hand-editable. There is
  still **no collection run endpoint** — order, progress and Stop belong to
  whoever watches the run.
- **A request with no expectation is not a pass, in all four tools.** The
  clients' `assertPasses` throws on one and the CLI counts `unchecked`
  separately, because an assertion that looked at nothing and returned green is
  the same false green `schema-validate.js` refuses to produce. Opt out
  explicitly (`requireCheck: false`) — never by folding it into the pass count.
  It is the same class of guard as the block clients refusing to claim a path
  dies on a tunneled host.
- **`{{ variables }}` resolve server-side, in `sendViaProxy`** (`utils/template.js`)
  — the one point the dashboard, a collection run, the CLI and the three clients
  share. Resolving in the dashboard would send a saved request by id with its
  braces intact, the exact drift `/saved-requests/:id/send` exists to stop. An
  undefined variable is a **400 naming it**, never an empty string: a blank
  token comes back 401 and tells you nothing. A malformed `{{ … }}` is refused
  rather than sent as literal braces; a literal `{{` goes in a variable, so
  there is no escape syntax. Filters are a closed list and unknown ones are
  refused by name — the same rule as `schema-validate.js`, and for the same
  reason. **The resolved request is validated again**, and that second pass is
  the only thing stopping a value holding `\r\n` from injecting a header; it is
  also why a path may _start_ with a template. `/replay` opts in rather than
  always resolving, because its headers and body come off the wire where `{{` is
  just bytes somebody's payload contained. On the by-id send, variables
  **merge** over the stored ones where `expect` replaces — you usually pass one,
  the credential the file should not hold.
- **A body with no content-type is invisible, so one is always defaulted**
  (`withContentTypeDefault` in `utils/admin/send.js`). An object body gets
  `application/json`, a **string** body — which is what the editor falls back to
  when the text is not JSON: XML, a form, a line of prose — gets
  `text/plain; charset=utf-8`. It used to get nothing, and nothing is the one
  answer that breaks everything downstream: no parser claims an undeclared body,
  so `req.body` stays undefined, the mock sees no body and `request-log.js`
  records none, because it logs `req.body`. The request went out complete and
  read as though it had been dropped. The instance app therefore also runs
  `express.text()` for `text/*` and XML (`utils/body-capture.js`) — without it
  the default alone would change nothing, since it is the parser that puts a
  body where the log and the mocks can see it. Forwarding is unaffected because
  the raw bytes are kept and re-sent (`writeRawBody`), not re-serialised. A
  **replay** stays excluded from the default: it inherits the captured
  content-type, and overriding that would change what the device actually sent.
- **Header names are put back the way they were sent, on the way upstream**
  (`restoreHeaderCase` in `utils/mock-pipeline.js`). Node's parser folds every
  incoming field name to lowercase in `req.headers`, and http-proxy builds the
  outbound request straight from that map — so `tokenId` reached the backend as
  `tokenid`, for device traffic and composed requests alike. Field names are
  case-insensitive per RFC 9110 and a correct backend does not care, but a
  debugging proxy that quietly rewrites what it forwards makes **itself** the
  variable in the bug you came here to find. The names come back from
  `req.rawHeaders`, the only place the wire truth survives; only names that
  actually differ are touched, and the **value** that goes out is always the
  proxy's (`host` is `changeOrigin`'s to set). It must run **before**
  `fixRequestBody`, which writes the body and flushes the header block, after
  which `setHeader` throws. `tests/header-case.test.js` asserts on the
  upstream's `rawHeaders` for the same reason — asserting on its `req.headers`
  would be asserting on Node's fold, and would pass with the fix deleted.
  The log carries the spellings **beside** the map rather than in it. A log
  entry's `requestHeaders` stays lowercase — it is what every mock matches on
  and what the capture clients are documented to read
  (`login.requestHeaders["x-api-key"]`), and re-keying it would return
  `undefined` for every assertion already written — so `requestHeaderCase` holds
  `{ tokenid: "tokenId" }` alongside it, and **only** for names that differ, so
  a browser (which sends lowercase) costs nothing. Everything that shows a
  reader what was _sent_ joins the two back up through `withHeaderCase`
  (`public/js/modules/util.js`): the inspector's header list, its cURL copy, and
  the retry editor's prefill. That helper is the backend rule written a second
  time on purpose — `public/js` has no build step and cannot import CommonJS —
  so `tests/util-headers.test.mjs` pins it separately.
- **A request rebuilt from the log has to be re-spelled before it is sent, and
  folded again inside `sendViaProxy`.** The replay route hands
  `applyNames(merged, entry.requestHeaderCase)` over, or a replay would send
  `tokenid` where the device sent `tokenId` and stop being the same request.
  That means `sendViaProxy` now receives names in any case, so it starts with
  `normalize` and renames once at the end: its hop-by-hop strip, its
  `content-type`/urlencoded check and its recomputed `content-length` all match
  on lowercase, and a caller writing `Content-Type` would have slipped past
  every one of them — a composed urlencoded body was being JSON-stringified for
  exactly that reason. `normalize` also collapses the two spellings a retry
  produces (the captured `content-type` plus the `Content-Type` the editor was
  prefilled with) into one field instead of sending both.
- **The dashboard API's own envelope was the first wall a large body hit**
  (`ADMIN_JSON_LIMIT` in `proxy-server.js`). `directAdminApp` ran a bare
  `express.json()`, whose default is `100kb`, and a composed request carries its
  entire body inside the JSON posted to `/__admin/send` — so a payload of a
  hundred thousand characters, an ordinary sync request for a real account, was
  refused before `/send` ever saw it. Worse, Express's default handler answers a
  body-parser failure with an **HTML error page**, and every caller here reads
  `{ error }` out of JSON: the HTML arrived as a parse failure carrying nothing,
  so the request read as _cut_ rather than _refused_. That error handler now
  answers JSON, and it is the reason the limit is set high rather than tuned —
  the limits that should bind a body are the ones further down that say
  something useful when they do (`MAX_PARSE_BYTES` decides whether the log can
  see it, `request-store.MAX_BYTES` whether it can be saved, and that one names
  its number in the message). README has the whole chain measured.
- **A form body's nested value is a document, not `[object Object]`**
  (`utils/form-encode.js`). `new URLSearchParams(body)` coerces every value with
  `String(v)`, so `{ email, data: { … } }` went out as
  `email=…&data=%5Bobject+Object%5D` — 49 bytes where 1400 were meant, answered
  `200`, because the request was well-formed and simply said nothing. The only
  way round it was hand-escaping the document into a JSON string, which is
  neither readable nor editable, and which is what made someone ask for filters
  on body fields. They are not the missing piece: for a form the **encoding is
  already automatic**, which is also why a `{{ }}` in a form field must _not_
  carry `| encodeURIComponent` — that encodes it twice. What was missing is the
  serialisation. An object becomes JSON; an **array** becomes repeated keys
  (`tag=a&tag=b`), which is the urlencoded convention and what
  `express.urlencoded({ extended: true })` reads straight back into an array,
  and its elements go through the same rule so an array of objects is not two
  `[object Object]`. Primitives keep `URLSearchParams`' own coercion exactly —
  `null` included — so nothing that already worked changes shape.
- **Reading a request body must not change it, and must not be able to reject
  it** (`utils/body-capture.js`). Parsing is what puts a body where the mocks and
  the log can see it, but it consumes the stream, so the proxy has to write one
  back out — and both halves of that used to alter traffic:
  - `fixRequestBody` re-serialises `req.body`, and for
    `x-www-form-urlencoded` that is `querystring.stringify` over whatever `qs`
    made of the bytes, where `[` and `]` mean **nested keys**. A 1282-character
    body containing a `[` reached the upstream as **136 characters**, cut at the
    first bracket, answered `200`. `keepRaw` (a `verify` hook) stashes the bytes
    and `writeRawBody` sends those; `fixRequestBody` stays only as the fallback
    for a body some other parser consumed. This also makes JSON byte-exact,
    which `JSON.stringify(req.body)` never was.
  - Express's parsers default to `limit: "100kb"` and answer **413** past it, so
    a large JSON or form request was refused **by the proxy** and never
    forwarded — while the same bytes sent as `image/png`, which no parser
    claims, went through fine. An intercepting proxy inventing a 4xx is worse
    than one that cannot show you the body, so anything over `MAX_PARSE_BYTES`
    (`IR_PROXY_MAX_PARSE_BYTES`, 5 MB) is left unparsed and streamed through: it
    arrives intact and is invisible in the dashboard. `limit` is set to the same
    number so the two can never disagree. A body with **no `Content-Length`** is
    the one case that can still 413 from here — it cannot be checked in advance.

  Both were `200`-shaped from the client's side for as long as they existed,
  which is why `tests/body-capture.test.js` asserts on the **bytes the upstream
  received** and never on a status code.

- **Anything that mirrors a saved request's shape must spread it, not list it.**
  `openInEditor` (`public/js/modules/collections.js`) built the editor's prefill
  field by field, and `variables` — added to a saved request long after that list
  was written — was simply missing from it: opening a request from the
  collections screen showed an empty Variables pane, and saving from there wiped
  what was stored. It reads as "variables don't save", which is the wrong bug to
  go looking for. It now spreads the record and peels off only `id`, `name` and
  `savedAt`. This is the same class as the four hand-built payloads that
  `POST /saved-requests/:id/send` exists to collapse — **a field added to a saved
  request is the thing to grep for when something silently arrives empty.**
- **A Send persists the variables and nothing else**
  (`PATCH /__admin/saved-requests/:id`, `persistVariables` in
  `request-editor.js`). Send is not Save for the path, headers or body — those
  edits are one-offs the closing modal throws away. Variables are the request's
  _inputs_, and one that evaporated on every Send would make the tab useful only
  to whoever remembered to press Save. The route takes **only** `variables` for
  exactly that reason: re-saving the whole record would persist the temporary
  edits too. It is best-effort on the client — the send already happened, so a
  failure logs rather than toasts.
- **`utils/schema-validate.js` refuses what it cannot do, by name.** It is a
  subset of JSON Schema, and `$ref`, `allOf`/`anyOf`/`oneOf`, `format` and any
  keyword it has never heard of all throw a 400 — from `assertSupported`, which
  runs on **save** as well as on send, so the refusal lands while you are still
  looking at the schema. Silently ignoring an unknown keyword would report green
  for a response it never checked, and a false green is the one failure that
  makes this feature worse than not having it. Keep that: the temptation when
  somebody pastes a real schema is to skip what does not parse. Patterns are
  compiled there too, so a broken regex fails in the editor and not mid-run.
- **A schema file _is_ the schema** (`utils/schema-store.js`, `schemas/`). No
  envelope, no `id`, no `savedAt` — because the point of these files is that
  `--schema-file` and CI read them directly, and a wrapper would mean unwrapping
  one before the CLI could take it. So the listing's metadata comes off the
  filesystem instead, which is the honest source for a file somebody may also
  edit by hand or pull from a branch, and the display name rides along as
  `title` rather than in a private key. Saving over a name **overwrites** where
  `request-store.js` numbers, because here the id is the whole identity — it is
  what you type after `--schema-file`, and a silent `order-2.schema.json` is a
  file nobody meant to make; the dashboard warns first, like `validateMockPath`.
  `POST /__admin/schemas` runs `assertSupported` **before writing**, so nothing
  the runner would refuse can be saved from the dashboard. And `schemas/` is
  **not** gitignored the way `requests/` is: a saved request carries
  `Authorization`, a schema carries the contract and belongs in review.
- Enabling SSL on a host that **pins its certificate** breaks that app's
  networking with no error a user can interpret. The tree warns before enabling;
  keep that warning.
- HTTP/3 hosts bypass the proxy entirely (QUIC is UDP, which isn't proxied), so
  they appear in the tree via a fallback CONNECT and never decrypt. Expected,
  not a bug.
- Tests must be hermetic: use `os.tmpdir()` and `IR_PROXY_CERTS_DIR` for anything
  touching disk or the CA.
- **Bind the app once, not once per request** (`tests/helpers/serve.js`).
  Supertest handed an Express _app_ does `app.listen(0)` for **every request**;
  across ~200 call sites that churns the ephemeral range fast enough that a
  recycled port occasionally takes an in-flight connection to a server that has
  never heard of the route — a 404, a parse error, or an empty list, in a
  different file each run and green on every retry. Handed an already-listening
  server it reuses the address, so `app = serve(app)` after the wiring fixes the
  whole class. It reproduced under `--runInBand`, which is what rules out every
  cross-worker explanation. A test that boots a real proxy takes its port from
  `tests/helpers/ports.js` for a separate reason: `startProxyServer` _scans_
  upward from what it is given, so hand-picked constants were overlapping
  ranges.
