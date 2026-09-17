# Test-automation clients

Four families of **standalone, dependency-free** client helpers for QA suites,
one file per language — copy the one you need into your repo as-is. All share
the same proxy autodetection (see [Port autodetection](#port-autodetection)).

- **[Capture sessions](#capture-sessions)** — mark a window, drive the app, and
  assert on the exact requests it sent.
- **[Toggling mocks](#toggling-mocks--control-clients)** — turn individual mocks
  on/off for an instance and read their state back.
- **[Blocking requests](#blocking-requests--block-clients)** — make a service
  die mid-test: the connection is destroyed rather than answered.
- **[Checking responses](#checking-responses--schema-clients)** — run the saved
  requests and assert the answers match their expected status and JSON Schema.

The first three **stage a condition**; the last one **asserts an outcome**.

## Capture sessions

Capture sessions let automated tests mark a **start**, drive the app through
the proxy, mark an **end**, and then assert on the exact requests the app sent
in that window (method, path, headers, parsed JSON body).

```text
test code                         mock proxy
─────────                         ──────────
POST /__admin/capture/start  ───▶ session "active"
(app makes calls through the proxy; every logged request is captured)
POST /__admin/capture/stop   ───▶ returns { requests: [...] }
assert requests[i].requestBody == expected payload
```

The HTTP API below is the canonical, language-agnostic contract. The client
helpers in this folder are **standalone, dependency-free single files** —
copy the one for your language into your QA repo as-is.

| Language          | File                                                     | Requires                          |
| ----------------- | -------------------------------------------------------- | --------------------------------- |
| JavaScript (Node) | [`js/capture-client.js`](./js/capture-client.js)         | Node 14+, CommonJS                |
| Python            | [`python/capture_client.py`](./python/capture_client.py) | Python 3.7+, stdlib only          |
| Java              | [`java/CaptureClient.java`](./java/CaptureClient.java)   | Java 11+, no deps (see JSON note) |

## HTTP API

All endpoints live under the admin prefix `/__admin` of the proxy/dashboard
server. Success responses are `{ "ok": true, ... }`; errors are
`{ "error": "message" }` with a 4xx status.

| Endpoint                           | Body / query                                     | Response                                                                               |
| ---------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `POST /capture/start`              | `{ name?, instanceId? }` (optional)              | `{ ok, sessionId, name, startedAt, filter }`                                           |
| `POST /capture/stop`               | `{ sessionId }`                                  | `{ ok, sessionId, name, status, startedAt, stoppedAt, count, droppedCount, requests }` |
| `GET /capture`                     | —                                                | `{ ok, sessions: [meta…] }` (no entries)                                               |
| `GET /capture/:sessionId`          | —                                                | `{ ok, session: meta }`                                                                |
| `GET /capture/:sessionId/requests` | `?method=&path=&pathPrefix=&instanceId=&source=` | `{ ok, sessionId, status, count, droppedCount, requests }`                             |
| `DELETE /capture/:sessionId`       | —                                                | `{ ok, sessionId }`                                                                    |

Semantics:

- **`requests` are chronological (oldest first)** — the natural order for
  asserting a flow. (The dashboard's `/log-history` is newest-first; capture
  is the opposite.)
- Each request entry is a full request-log record:
  `{ id, timestamp, instanceId, host, port, protocol, durationMs, method, path,
status, source, mockName, delay, requestHeaders, requestBody, responseHeaders,
responseBody, … }`.
  `requestBody`/`responseBody` are parsed JSON when the payload was JSON.
  `host`/`port`/`protocol` say where the request was actually addressed, and
  `durationMs` is the wall-clock time the client experienced (mock delay and
  simulated latency included).
- **`stop` is idempotent** and returns the entries inline — the common flow is
  a single round-trip. Re-stopping returns the same frozen data.
- **`start` filter**: pass `instanceId` to capture only one configured backend
  instance; it is validated against the config (404 if unknown).
- **Bodies must be JSON**: `start`/`stop` require
  `Content-Type: application/json` — a body sent without it returns 400
  instead of silently starting an unfiltered session. Alternatively, pass the
  fields as query parameters:
  `POST /capture/start?name=smoke&instanceId=api` and
  `POST /capture/stop?sessionId=…` (handy for shell scripts).
- **Query filters** on `/requests`: `method` exact (case-insensitive); `path`
  exact against the pathname (so `path=/api/login` matches
  `/api/login?lang=en`); `pathPrefix` prefix of the full stored path;
  `instanceId` and `source` (`mock` | `proxy` | `intercept` | `server-off`)
  exact.
- **Limits**: a session stores up to 1000 entries — beyond that,
  `droppedCount` grows instead. Bodies over 256 KB arrive truncated with
  `requestTruncated`/`responseTruncated` flags. Up to 25 sessions may be
  active at once (429 past that); finished sessions are kept until 25 newer
  ones finish. Active sessions abandoned for 10 minutes expire (entries kept).
- Sessions are **in-memory only**: they don't survive a server restart, and
  clearing the dashboard activity log does **not** affect captured entries.

### Port autodetection

Every client honors `MOCK_HOST` / `MOCK_PORT` environment variables, or scans
ports `8888…8908` probing `/__admin/health` to find the proxy (port 8888 is
often already held by another proxy). Passing an explicit port to the
constructor skips the scan — recommended in hermetic tests.

## Examples

### JavaScript (Jest / Playwright / WebdriverIO)

```js
const { CaptureClient } = require("./capture-client");

test("login sends the right payload", async () => {
  const client = new CaptureClient(); // or new CaptureClient({ port: 8889 })
  await client.start({ name: "login-test" });

  await app.login("user", "pass"); // drive the app through the proxy

  const { requests } = await client.stop();
  const login = requests.find((r) => r.path === "/api/login");
  expect(login.requestBody).toEqual({ user: "user", pass: "pass" });
  expect(login.requestHeaders["x-api-key"]).toBe("expected-key");
});
```

### Python (pytest / behave / Appium)

```python
from capture_client import capture

def test_login_sends_right_payload():
    with capture(name="login-test") as session:
        app.login("user", "pass")  # drive the app through the proxy

    login = next(r for r in session.requests if r["path"] == "/api/login")
    assert login["requestBody"] == {"user": "user", "pass": "pass"}
```

Or imperatively with `CaptureClient()` (`start()` / `stop()` /
`get_requests(method="POST", path="/api/login")`).

### Java (JUnit / TestNG, with your JSON library)

The Java client returns **raw JSON strings** — parse them with the JSON
library your suite already uses:

```java
CaptureClient client = new CaptureClient(); // or new CaptureClient("localhost", 8889)
String sessionId = client.start("login-test", null);

app.login("user", "pass"); // drive the app through the proxy

// Jackson:
JsonNode stop = new ObjectMapper().readTree(client.stopRaw(sessionId));
JsonNode login = null;
for (JsonNode r : stop.get("requests")) {
  if (r.get("path").asText().equals("/api/login")) login = r;
}
assertEquals("user", login.get("requestBody").get("user").asText());

// Gson equivalent:
// JsonObject stop = JsonParser.parseString(client.stopRaw(sessionId)).getAsJsonObject();
```

### cURL (shell scripts / CI)

```bash
SESSION=$(curl -s -X POST localhost:8889/__admin/capture/start \
  -H "Content-Type: application/json" -d '{"name":"smoke"}' | jq -r .sessionId)

# ... run the app's actions ...

# Full entries (instanceId, status, source, requestHeaders, requestBody,
# responseHeaders, responseBody, …):
curl -s -X POST localhost:8889/__admin/capture/stop \
  -H "Content-Type: application/json" -d "{\"sessionId\":\"$SESSION\"}" \
  | jq '.requests'

# Or project just the fields you want to eyeball — note this jq filter is
# what limits the output, not the API:
# | jq '.requests[] | {method, path, requestBody}'
```

## Caveats for assertions

- Only traffic to **configured targets** (see `config.js`) is captured —
  unconfigured hosts pass through as opaque TCP tunnels.
- `requestHeaders` includes proxy/transport headers; assert on the specific
  headers you care about, not the whole map. Its **keys are always lowercase**
  — that is Node's parse of the request, not a choice — so look up
  `"x-api-key"` however the app spelled it. The proxy forwards the original
  spelling upstream, and the entry's `requestHeaderCase` names the ones that
  differ (`{ "x-api-key": "X-API-Key" }`) if you need to assert on that
  too; only this map is normalised.
- Bodies are compared as **parsed JSON** (deep equality), not raw bytes —
  key order and whitespace differences are invisible. Non-JSON bodies (XML,
  plain text) are captured as strings only when Express can read them.
- Responses served by a mock with `interceptResponse`/transform are captured
  **post-transform** — i.e., what the app actually received.
- A dashboard "Replay" during a window shows up flagged `replayed: true`.

## Toggling mocks — control clients

Control clients turn individual mocks **on or off** for a configured backend
instance and read the resulting state back — so a suite can stage a scenario
(e.g. enable `Account Locked` before a "blocked login" test) without touching
the dashboard. Same autodetection and same drop-in philosophy as the capture
clients.

| Language          | File                                               | Requires                 |
| ----------------- | -------------------------------------------------- | ------------------------ |
| JavaScript (Node) | [`js/mock-client.js`](./js/mock-client.js)         | Node 14+, CommonJS       |
| Python            | [`python/mock_client.py`](./python/mock_client.py) | Python 3.7+, stdlib only |
| Java              | [`java/MockClient.java`](./java/MockClient.java)   | Java 11+, no deps        |

### HTTP API

| Endpoint                  | Body                                        | Response                                                                            |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /toggle`            | `{ instanceId, mockName, enabled }`         | `{ ok, instanceId, mockName, enabled }`                                             |
| `POST /toggle-bulk`       | `{ instanceId, mockNames: [...], enabled }` | `{ ok, instanceId, enabled, count, mocks }`                                         |
| `GET  /state/:instanceId` | —                                           | `{ instanceId, isActive, targetUrl, latency, summary: { on, off, unset }, states }` |
| `GET  /mocks`             | —                                           | `{ mocks: [{ name, file, folder, delay, servers }] }`                               |

Semantics:

- **`enabled` is the authoritative result** — `POST /toggle` echoes the state it
  just set, so a client gets the new state without a second read.
- **State is a tri-state.** `GET /state/:instanceId` returns a `states` map of
  only the mocks with an _explicit_ toggle. A mock absent from the map is
  **unset** — the pipeline's default applies. Clients surface this as
  `true` / `false` / `null` (JS, Python) or `Boolean.TRUE` / `FALSE` / `null`
  (Java).
- **Scope.** A mock with a `servers: [...]` field only applies to those
  instances. `POST /toggle` returns **409** when the mock isn't scoped to the
  given instance; `POST /toggle-bulk` silently **skips** out-of-scope names, so
  its `count`/`mocks` reflect what actually changed.
- **Errors** are `{ "error": "message" }` with **404** (unknown instance or
  mock), **409** (out of scope), or **400** (missing fields); every client
  raises with the server's message.
- Toggles are **persisted** to `state.json` and survive restarts (unlike capture
  sessions). Use the temporary-scope helpers below to leave state as you found
  it.

### Examples

JavaScript:

```js
const { MockClient } = require("./mock-client");
const client = new MockClient(); // or new MockClient({ port: 8889 })

await client.setMock("api", "Account Locked", true); // → { instanceId, mockName, enabled: true }
await client.getState("api", "Account Locked"); // → true | false | null
await client.setMocks("api", ["All Offers", "Account Locked"], false); // bulk

// Stage a mock for one block, then restore the prior state automatically:
await client.withMock(
  { instanceId: "api", mockName: "Account Locked", enabled: true },
  async () => {
    await app.login("locked", "pass"); // drive the app through the proxy
  }
);
```

Python:

```python
from mock_client import MockClient, mock_enabled

client = MockClient()
client.set_mock("api", "Account Locked", True)
client.get_state("api", "Account Locked")  # True | False | None

# Stage a mock for one block, then restore the prior state automatically:
with mock_enabled("api", "Account Locked"):
    app.login("locked", "pass")  # drive the app through the proxy
```

Java (single scalars are returned typed; lists/state come back as raw JSON for
your JSON library):

```java
MockClient client = new MockClient(); // or new MockClient("localhost", 8889)
client.setMock("api", "Account Locked", true);
Boolean state = client.getState("api", "Account Locked"); // TRUE | FALSE | null

// Stage a mock for one block, then restore the prior state automatically:
try (AutoCloseable r = client.temporarilySet("api", "Account Locked", true)) {
  app.login("locked", "pass"); // drive the app through the proxy
}

String mocks = client.listMocksRaw();
String stateJson = client.getInstanceStateRaw("api");
```

cURL:

```bash
curl -s -X POST localhost:8889/__admin/toggle \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"api","mockName":"Account Locked","enabled":true}'
# → {"ok":true,"instanceId":"api","mockName":"Account Locked","enabled":true}
```

## Blocking requests — block clients

Block clients make a service **die**. A blocked path's connection is
**destroyed rather than answered**, so the caller sees a reset — which is what a
service that is genuinely down looks like from the outside.

That is the reason this is worth driving from a test, and it is worth being
precise about why the other two switches don't cover it: turning a mock on gives
you any status you like, and the `isActive: false` switch gives you a 503. Both
are _responses_. An app that handles a 503 has not been shown what happens when
the network simply stops.

| Language          | File                                                 | Requires                 |
| ----------------- | ---------------------------------------------------- | ------------------------ |
| JavaScript (Node) | [`js/block-client.js`](./js/block-client.js)         | Node 14+, CommonJS       |
| Python            | [`python/block_client.py`](./python/block_client.py) | Python 3.7+, stdlib only |
| Java              | [`java/BlockClient.java`](./java/BlockClient.java)   | Java 11+, no deps        |

### HTTP API

| Endpoint             | Body / query              | Response                                         |
| -------------------- | ------------------------- | ------------------------------------------------ |
| `POST /hosts/block`  | `{ host, path, blocked }` | `{ ok, host, blocks: [...], ssl }`               |
| `GET  /hosts/blocks` | —                         | `{ ok, blocks: { host: [...] } }`                |
| `GET  /hosts/blocks` | `?host=`                  | `{ ok, host, blocks: [...], ssl }`               |
| `GET  /hosts/blocks` | `?host=&path=`            | `{ ok, host, blocks, ssl, path, rule, blocked }` |

Semantics:

- **A rule is a path prefix.** `/orders` kills `/orders` and `/orders/42`, and
  pointedly not `/orders-archive` — prefix matching on raw strings is how you
  take down a neighbour whose name merely starts the same way. `/` is the
  exception, matched exactly.
- **`blocks` is the authoritative result**, and may be _shorter_ than you
  expect: adding a rule drops the narrower ones it now covers, because a list of
  rules that decide nothing is a list nobody trusts.
- **Unblocking is exact.** It lifts the rule that names the path. A path blocked
  by an ancestor stays blocked — `rule` from the `?path=` form is what points you
  at the one actually in play. Unblocking a path that was never a rule is a
  no-op, not an error.
- **`?path=` is answered server-side on purpose.** The prefix rule lives in one
  place (`utils/blocking.js`); a client evaluating it locally would be a third
  copy, free to drift from the one the proxy enforces. So "would this die?" and
  "did this die?" can never disagree.
- **`ssl` rides along on every host-scoped response**, because blocking runs
  inside the decrypted pipeline: with SSL off the host is tunneled, the rule is
  stored, and nothing ever fires it. The clients turn that into a thrown error
  rather than letting a suite assert against a rule that cannot act.
- Rules are **persisted** to `state.json` and survive restarts (unlike capture
  sessions). Use the temporary-scope helpers below to leave state as you found
  it.
- **Reads come from `state.json`, not the host registry.** The registry is
  runtime-only and LRU-capped, and it spares hosts with SSL or a focus but not
  hosts kept alive purely by a block rule — so a busy session could hide rules
  that are still killing requests.

### Examples

JavaScript:

```js
const { BlockClient } = require("./block-client");
const client = new BlockClient(); // or new BlockClient({ port: 8889 })

await client.block("api.example.com", "/orders"); // → ["/orders"]
await client.ruleFor("api.example.com", "/orders/42"); // → "/orders"
await client.isBlocked("api.example.com", "/orders-archive"); // → false
await client.unblock("api.example.com", "/orders"); // → []

// Kill a service for one block, restoring the host's prior rules afterwards:
await client.withBlock({ host: "api.example.com", path: "/orders" }, async () => {
  await expect(app.loadOrders()).rejects.toThrow(); // the socket dies
});
```

Python:

```python
from block_client import BlockClient, blocked

client = BlockClient()
client.block("api.example.com", "/orders")
client.rule_for("api.example.com", "/orders/42")   # → "/orders"

# Kill a service for one block, restoring the host's prior rules afterwards:
with blocked("api.example.com", "/orders"):
    with pytest.raises(ConnectionError):
        app.load_orders()
```

Java (lists come back typed; the whole-map read is raw JSON for your library):

```java
BlockClient client = new BlockClient(); // or new BlockClient("localhost", 8889)
client.block("api.example.com", "/orders");
String rule = client.ruleFor("api.example.com", "/orders/42"); // "/orders"

// Kill a service for one block, restoring the host's prior rules afterwards:
try (AutoCloseable r = client.temporarilyBlocked("api.example.com", "/orders")) {
  assertThrows(IOException.class, () -> app.loadOrders());
}
```

cURL:

```bash
curl -s -X POST localhost:8889/__admin/hosts/block \
  -H "Content-Type: application/json" \
  -d '{"host":"api.example.com","path":"/orders","blocked":true}'
# → {"ok":true,"host":"api.example.com","blocks":["/orders"],"ssl":true}

# Would this path die, and which rule kills it?
curl -s "localhost:8889/__admin/hosts/blocks?host=api.example.com&path=/orders/42"
# → {"ok":true,...,"path":"/orders/42","rule":"/orders","blocked":true}
```

### The restore is a whole-list restore

`withBlock` / `temporarily_blocked` / `temporarilyBlocked` put back **every**
rule the host had, not just the one they added — because adding a rule can
_remove_ others. Blocking `/orders` absorbs an existing `/orders/42`, so lifting
`/orders` alone would leave the host **less** blocked than it started. Removals
go first: re-adding a narrow rule while the broad one is still in place is a
no-op.

### From the shell

The CLI covers the same ground without a client:

```bash
npm run mock -- block   --host api.example.com --path /orders
npm run mock -- blocks  --host api.example.com --path /orders/42   # would it die?
npm run mock -- unblock --host api.example.com --path /orders
npm run mock -- blocks                                             # everything
```

## Checking responses — schema clients

The other three stage a condition. This one runs the proxy's **saved requests**
and tells you whether the responses were what they were supposed to be — an
expected status, a JSON Schema for the body, or both.

That makes a collection into something a CI job can run: `assertCollectionPasses`
throws listing every problem, and the CLI's `run` exits non-zero.

| Language          | File                                                   | Requires                 |
| ----------------- | ------------------------------------------------------ | ------------------------ |
| JavaScript (Node) | [`js/schema-client.js`](./js/schema-client.js)         | Node 16+, CommonJS       |
| Python            | [`python/schema_client.py`](./python/schema_client.py) | Python 3.7+, stdlib only |
| Java              | [`java/SchemaClient.java`](./java/SchemaClient.java)   | Java 11+, no deps        |

### HTTP API

| Endpoint                        | Body         | Response                                      |
| ------------------------------- | ------------ | --------------------------------------------- |
| `GET  /saved-requests`          | —            | `{ requests: [{ id, name, path, expect }] }`  |
| `GET  /collections`             | —            | `{ collections: [{ id, name, requests }] }`   |
| `POST /saved-requests/:id/send` | `{}`         | `{ ok, status, expect?: { passed, errors } }` |
| `POST /saved-requests/:id/send` | `{ expect }` | same, checked against **your** expectation    |

Semantics:

- **The schema is never evaluated in the client.** Every check is answered by
  the same `utils/schema-validate.js` the dashboard uses, so a client can never
  drift from what the proxy enforces — the same reason the block clients ask the
  server whether a path is blocked instead of re-deriving the prefix rule.
- **`ok: true` still means "it went out and came back".** A response that failed
  its check is a _successful send of a request whose answer was wrong_. The
  result carries `status` and `passed` separately for exactly that reason.
- **`expect` in the body replaces the stored expectation** for that call, which
  is how you keep schemas in **your** repo, in version control, next to the
  tests that use them. `expect: null` sends and checks nothing.
- **`expect` is absent from the response when nothing was checked** — which the
  clients surface as `checked: false`, never as a pass. See below.
- A saved request is sent **by id**, whole: the server assembles the payload, so
  a field added to a saved request cannot go missing from one caller and not
  another.

### A request with no expectation is not a pass

This is the guard worth knowing about, and it is deliberate in all four tools:
`assertPasses` **throws** on a request that checks nothing, rather than
returning green for an assertion that looked at nothing. It is the same class of
guard as the block clients refusing to claim a path dies on a tunneled host.

Pass your own `expect`, or opt out explicitly with `requireCheck: false` /
`require_check=False` / `new SchemaClient(host, port, false)`.

Ask first, with `checks()`, or `npm run mock -- checks`:

```
{ } Get order            GET /api/orders/42   status 200 + schema
    Warm the cache       GET /api/ping        no check
```

### Examples

```js
// JavaScript — Jest / Playwright
const { SchemaClient, ExpectationFailed } = require("./schema-client");
const client = new SchemaClient();

test("the order endpoint still returns what we parse", async () => {
  await client.assertPasses("get-order"); // throws, listing every problem
});

test("the checkout flow holds together", async () => {
  await client.assertCollectionPasses("checkout-flow");
});

// Or with a schema kept in this repo, next to this test:
await client.assertPasses("get-order", {
  expect: { status: 200, schema: require("./schemas/order.json") },
});

// The verdict as data, when you want to assert on it yourself:
const { status, checked, passed, errors } = await client.run("get-order");
```

```python
# Python — pytest
import json
from schema_client import SchemaClient, ExpectationFailed

client = SchemaClient()

def test_order_endpoint():
    client.assert_passes("get-order")

def test_checkout_flow():
    client.assert_collection_passes("checkout-flow")

def test_against_our_own_schema():
    with open("schemas/order.json") as fh:
        client.assert_passes("get-order", expect={"status": 200, "schema": json.load(fh)})

# Module-level shortcut, mirroring capture() / mock_set() / blocked():
from schema_client import check
check("get-order")
```

```java
// Java — JUnit
SchemaClient client = new SchemaClient();

@Test
void orderEndpointStillReturnsWhatWeParse() throws Exception {
  client.assertPasses("get-order");
}

@Test
void checkoutFlowHoldsTogether() throws Exception {
  client.assertCollectionPasses("checkout-flow");
}

// With a schema from this repo:
client.assertPasses("get-order",
    "{\"status\":200,\"schema\":" + Files.readString(Path.of("schemas/order.json")) + "}");

// The verdict as data:
SchemaClient.Result r = client.run("get-order");
if (r.checked && !r.passed) r.errors.forEach(System.out::println);
```

```bash
# cURL — run one saved request with its stored expectation
curl -s -XPOST localhost:8889/__admin/saved-requests/get-order/send -d '{}' \
  -H 'content-type: application/json'
# → {"ok":true,"status":200,"expect":{"passed":true,"errors":[]}}

# ...or against a schema of your own
curl -s -XPOST localhost:8889/__admin/saved-requests/get-order/send \
  -H 'content-type: application/json' \
  -d '{"expect":{"status":200,"schema":{"type":"object","required":["id"]}}}'
# → {"ok":true,"status":200,"expect":{"passed":false,"errors":["/id: required property is missing"]}}
```

### From the shell

The CLI covers the same ground without a client, and **exits non-zero when
anything failed** — which is the point in CI:

```bash
npm run mock -- run --collection checkout-flow
npm run mock -- run --request get-order --schema-file ./schemas/order.json
npm run mock -- run --all
npm run mock -- checks                 # which requests actually check anything
```

```
▶ Checkout flow — 3 requests

  ✓ Get order (checked)      GET /api/orders/42   200  15 ms
  ✗ Get order (wrong shape)  GET /api/orders/42   200   4 ms
       expected status 201, got 200
       /total: required property is missing
  – Get order (unchecked)    GET /api/orders/42   200   4 ms

3 sent · 1 passed · 1 failed · 1 unchecked
```

The `–` and the separate `unchecked` count are the same guard as above: a
request that checks nothing is never folded into "passed".

## Smoke-testing the clients

The JS clients are covered by `tests/capture-client-js.test.js`,
`tests/mock-client-js.test.js`, `tests/block-client-js.test.js` and
`tests/schema-client-js.test.js`. Python and
Java have no automated harness here; to smoke them: start the server
(`npm run dev`), note the printed port, then run the examples above with
`MOCK_PORT=<port>`.
