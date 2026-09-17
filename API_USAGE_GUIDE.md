# Usage Guide: IR Proxy API

The mock server provides a CLI and an HTTP API designed to easily integrate with local scripts, terminals, and automated testing frameworks (Playwright, Cypress, Appium).

---

## 1. CLI Usage Examples (NPM Scripts)

The CLI is ideal for local use by a developer or QA engineer who wants to quickly toggle states without opening a browser.

**View current server status (Active mocks and targets):**

```bash
npm run mock:status
```

**List all mocks and search for a specific one:**

```bash
npm run mock:list --search "vehicles"
```

**Enable or disable a mock by name:**

```bash
npm run mock -- toggle --instance api --mock "Account Locked" --on
npm run mock -- toggle --instance auth --mock "Minimum Version" --off
```

**Enable all mocks in a folder (Bulk):**

```bash
# Enable all mocks inside the "offers" folder for the auth instance
npm run mock -- bulk --instance auth --folder "offers" --on
```

**Simulate network latency on an instance (mocks and proxied responses):**

```bash
# Every api response now takes an extra 1.5s
npm run mock -- latency --instance api --ms 1500

# Check the current value / turn it off
npm run mock -- latency --instance api
npm run mock -- latency --instance api --ms 0
```

**Make a service die (blocking):**

```bash
# Calls to /orders — and everything under it — now get no response at all:
# the connection is destroyed, not answered.
npm run mock -- block --host api.example.com --path /orders

# Would this path die, and which rule kills it?
npm run mock -- blocks --host api.example.com --path /orders/42
# → api.example.com/orders/42 → DIES (blocked by /orders)

# Lift it again (exact: a path blocked by a parent stays blocked)
npm run mock -- unblock --host api.example.com --path /orders

# Everything that is blocked, across every host
npm run mock:blocks
```

**Check that the responses are the right shape:**

```bash
# Run a collection, in order. Exits non-zero if anything failed — which is
# what makes this something a CI job can gate on.
npm run mock -- run --collection checkout-flow
# ▶ Checkout flow — 3 requests
#   ✓ Get order (checked)      GET /api/orders/42   200  15 ms
#   ✗ Get order (wrong shape)  GET /api/orders/42   200   4 ms
#        expected status 201, got 200
#        /total: required property is missing
#   – Get order (unchecked)    GET /api/orders/42   200   4 ms
#
# 3 sent · 1 passed · 1 failed · 1 unchecked

# One request, against a schema kept in *this* repo rather than the dashboard
npm run mock -- run --request get-order --schema-file ./schemas/order.schema.json

# Which saved requests actually assert anything? A green run of requests that
# check nothing passes every time.
npm run mock:checks
```

> ⚠️ Blocking runs inside the **decrypted** pipeline. With SSL proxying off for
> the host, the rule is stored and never fires — the CLI says so rather than
> claiming the path is dead.

**Save current state as a "Profile" (Snapshot) and load it later:**

```bash
# Save the entire state of api and auth
npm run mock -- profile:save --name "happy-path-checkout"

# Next day, or after running other tests, restore the state
npm run mock -- profile:load --name "happy-path-checkout"
```

---

## 2. cURL Usage Examples (Bash Scripts or CI/CD)

cURL is ideal for integrations in Jenkins pipelines, GitHub Actions, or custom `sh` scripts.

**View available mocks:**

```bash
curl -s http://localhost:8888/__admin/mocks | jq .
```

**View specific status of an instance (e.g., `api`):**

```bash
curl -s http://localhost:8888/__admin/state/api | jq .
```

**Enable a mock by its exact name:**

```bash
curl -X POST http://localhost:8888/__admin/toggle \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "api", "mockName": "Minimum Version", "enabled": true}'
```

**Enable a mock by its file name (Recommended for scripts):**
_It's safer to use the path because it doesn't contain spaces._

```bash
curl -X POST http://localhost:8888/__admin/toggle-by-path \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "api", "path": "account/locked_user.mock.js", "enabled": true}'
```

**Enable general error simulation (Change backend to invalid):**

```bash
curl -X POST http://localhost:8888/__admin/instance-settings \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "api", "targetUrl": "https://invalid-backend.com"}'
```

**Simulate a slow network (latency in ms, 0 disables):**

```bash
curl -X POST http://localhost:8888/__admin/instance-settings \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "api", "latency": 2000}'
```

**Add a new backend to intercept at runtime (auto-assigned incremental port):**
_The proxy starts intercepting the host immediately — no restart. `target` is
required and must be `http(s)`; the `id` is derived from the name/host and the
`port` is the next free increment. Adding a target explicitly also turns SSL
proxying **on** for its host, since that is plainly the intent. The instance is
persisted in `state.json` and survives restarts. A target whose host is already
intercepted returns `409` — use `POST /__admin/hosts/ssl` instead, which is
idempotent._

```bash
curl -X POST http://localhost:8888/__admin/instances \
  -H "Content-Type: application/json" \
  -d '{"target": "https://api.example.com", "name": "Example API"}'
# → 201 {"ok":true,"instance":{"id":"example-api","port":3003,
#         "target":"https://api.example.com","name":"Example API","dynamic":true}}
```

**Remove a dynamically-added instance** (static `config.js` instances return `400`):

```bash
curl -X DELETE http://localhost:8888/__admin/instances/example-api
```

**Replay a captured request through the full pipeline:**
_Take the `id` from `/__admin/log-history`; the result appears as a new log
entry flagged `replayed`. Returns `409` if the logged request body was
truncated._

```bash
ID=$(curl -s http://localhost:8888/__admin/log-history?limit=1 | jq -r '.[0].id')
curl -X POST http://localhost:8888/__admin/replay \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$ID\"}"
```

**Capture a window of traffic and assert what the app sent:**
_Start a capture session, drive the app, stop it, and inspect every request
captured in between (chronological, with parsed JSON bodies). Full contract
and client helpers for JS/Python/Java in [clients/README.md](./clients/README.md)._

```bash
SESSION=$(curl -s -X POST http://localhost:8888/__admin/capture/start \
  -H "Content-Type: application/json" -d '{"name":"login-flow"}' | jq -r .sessionId)

# ... the app performs its actions through the proxy ...

# Each entry carries the full record: instanceId, status, source, mockName,
# requestHeaders, requestBody, responseHeaders, responseBody, timestamps…
curl -s -X POST http://localhost:8888/__admin/capture/stop \
  -H "Content-Type: application/json" -d "{\"sessionId\":\"$SESSION\"}" \
  | jq '.requests'

# Tip: pipe through a jq projection only when you want a compact view, e.g.
# | jq '.requests[] | {method, path, requestBody}'
```

### Hosts & SSL proxying

The proxy records every host the connected devices reach for, but only decrypts
the ones with SSL proxying enabled. Everything else is tunneled untouched.

**List every observed host:**
_`ssl` says whether it is decrypted. Watch `connections` vs `requests`: with SSL
off you only see CONNECT tunnels, and one tunnel carries many requests._

```bash
curl -s http://localhost:8888/__admin/hosts | jq '.hosts[] | {host, ssl, connections, requests, errors}'
```

**Turn SSL proxying on or off for a host:**
_Enabling promotes the host to an instance (idempotent — an already-intercepted
host returns its existing `instanceId` rather than `409`). Disabling only clears
the flag; the instance and its mock toggles are kept. Takes effect on the next
connection — tunnels already open keep the mode they started with._

```bash
curl -X POST http://localhost:8888/__admin/hosts/ssl \
  -H "Content-Type: application/json" \
  -d '{"host": "api.example.com", "enabled": true}'
# → {"ok":true,"host":"api.example.com","ssl":true,"instanceId":"api-example-com"}
```

> ⚠️ Enabling SSL for a host whose app pins its certificate will break that
> app's networking until it is turned back off.

**Block a path — the connection dies instead of answering:**
_Rules are **prefixes**: `/orders` blocks `/orders/42` and pointedly not
`/orders-archive`. The response returns the whole list, because adding a broader
rule collapses the ones it now covers, plus `ssl` — with SSL off the rule is
stored and never fires. Unblocking is exact: it lifts the rule that names the
path, so a path blocked by an ancestor stays blocked._

```bash
curl -X POST http://localhost:8888/__admin/hosts/block \
  -H "Content-Type: application/json" \
  -d '{"host": "api.example.com", "path": "/orders", "blocked": true}'
# → {"ok":true,"host":"api.example.com","blocks":["/orders"],"ssl":true}
```

**Read what is blocked:**
_Three shapes. The `path` form is answered by the same rule the proxy enforces,
so "would this die?" and "did this die?" can never disagree._

```bash
# Every host that has rules
curl -s http://localhost:8888/__admin/hosts/blocks
# → {"ok":true,"blocks":{"api.example.com":["/orders"]}}

# One host's rules (plus whether they can fire at all)
curl -s 'http://localhost:8888/__admin/hosts/blocks?host=api.example.com'

# Would this exact path die, and which rule kills it?
curl -s 'http://localhost:8888/__admin/hosts/blocks?host=api.example.com&path=/orders/42'
# → {"ok":true,...,"path":"/orders/42","rule":"/orders","blocked":true}
```

**Run a saved request and check the response:**

```bash
# With whatever expectation it was saved with
curl -s -X POST http://localhost:8888/__admin/saved-requests/get-order/send \
  -H "Content-Type: application/json" -d '{}'
# → {"ok":true,"status":200,"expect":{"passed":true,"errors":[]}}

# Against a schema of your own — this replaces the stored expectation
curl -s -X POST http://localhost:8888/__admin/saved-requests/get-order/send \
  -H "Content-Type: application/json" \
  -d '{"expect":{"status":200,"schema":{"type":"object","required":["id"]}}}'
# → {"ok":true,"status":200,"expect":{"passed":false,
#      "errors":["/id: required property is missing"]}}
```

Note that `"ok": true` with `"status": 200` still means the request went out and
came back fine — a failed expectation is a successful send of a request whose
**answer** was wrong. When nothing was checked, `expect` is simply absent, which
is not the same as passing.

**Variables** — `{{ name }}` in the path, the header values or the body,
resolved server-side just before the request goes out:

```bash
curl -s -X POST http://localhost:8888/__admin/send \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"api","path":"/orders/{{ id }}?q={{ q | encodeURIComponent }}",
       "headers":{"authorization":"Bearer {{ token }}"},
       "variables":{"id":"42","q":"tyres & wheels","token":"s3cret"}}'
# the mock sees: GET /orders/42?q=tyres%20%26%20wheels
```

Filters are piped, from a closed list (`encodeURIComponent`, `encodeURI`,
`base64`, `json`, `trim`, `uppercase`, `lowercase`). Undefined variables and
unknown filters are refused before anything is sent:

```bash
# → {"error":"\"token\" is not defined (used in header \"authorization\") — defined: id"}
# → {"error":"\"encodeUri\" is not a filter (in the path) — available: encodeURIComponent, …"}
```

Sending a **saved** request merges the variables you pass over the ones stored
with it, which is how a credential stays out of the file:

```bash
curl -s -X POST http://localhost:8888/__admin/saved-requests/get-order/send \
  -H "Content-Type: application/json" \
  -d '{"variables":{"token":"'"$QA_TOKEN"'"}}'
```

From the CLI that is `--var`, repeatable, and it applies to every request in the
run — a whole collection can share one token:

```bash
npm run mock -- run --collection checkout-flow --var token=$QA_TOKEN --var id=42
npm run mock -- run --request get-order --var 'creds=user:p=ss'
```

The pair splits on the **first** `=` only, so a base64 or padded value survives
intact. Whether a name is usable is still the server's rule, not a second copy
in the CLI:

```bash
npm run mock -- run --request get-order --var 'bad name=x'
# ✗ Get order   POST /orders/{{ orderId }}
#      "bad name" is not a usable variable name — letters, digits, "_" and "-", …
```

**Schema files** — the same schemas as files in `schemas/`, which is what
`--schema-file` and CI read. The dashboard's Expect pane saves and loads them
here; the file is plain JSON Schema with nothing wrapped around it, so `curl`
can write one straight out of your API's docs:

```bash
curl -s http://localhost:8888/__admin/schemas
# → {"schemas":[{"id":"order-response","title":"Order response",
#      "bytes":214,"savedAt":"2026-08-25T10:12:00.000Z"}],"dir":"…/schemas"}

curl -s -X POST http://localhost:8888/__admin/schemas \
  -H "Content-Type: application/json" \
  -d '{"name":"Order response","schema":{"type":"object","required":["id"]}}'
# → {"ok":true,"id":"order-response","title":"Order response","schema":{…}}

curl -s http://localhost:8888/__admin/schemas/order-response
curl -s -X DELETE http://localhost:8888/__admin/schemas/order-response
```

The save runs the same `assertSupported` a send does, so a schema the runner
would refuse is a `400` here rather than a failure halfway through a run:

```bash
curl -s -X POST http://localhost:8888/__admin/schemas \
  -H "Content-Type: application/json" \
  -d '{"name":"From the docs","schema":{"$ref":"#/$defs/order"}}'
# → {"error":"this validator does not support \"$ref\" at (root) —
#      references are not resolved here — inline the definition"}
```

**Move a host between the dashboard tree's sections:**

```bash
curl -X POST http://localhost:8888/__admin/hosts/focus \
  -H "Content-Type: application/json" \
  -d '{"host": "api.example.com", "focus": "focus"}'   # none | focus | ignore
```

**Clear one host's captured requests** (an empty body still clears everything):

```bash
curl -X POST http://localhost:8888/__admin/log-clear \
  -H "Content-Type: application/json" -d '{"host": "api.example.com"}'
# → {"ok":true,"removed":42}
```

**Forget a host entirely** (its mocks are kept):

```bash
curl -X DELETE http://localhost:8888/__admin/hosts/api.example.com
```

**Proxy address for device setup:**

```bash
curl -s http://localhost:8888/__admin/proxy/info
# → {"localIPs":["192.168.1.52"],"port":8888,"caReady":true}
```

---

## 3. Integration Examples for Testing Automation

The best way to use the mock server in testing (Cypress, Playwright, WebdriverIO, Appium) is to **enable the mock right before the step that requires it, and disable it in the teardown**.

### Example in **Playwright** (JavaScript/TypeScript)

```typescript
import { test, expect, request } from "@playwright/test";

// Utility to easily change mocks
async function setMock(mockPath: string, enabled: boolean) {
  const adminApi = await request.newContext({ baseURL: "http://localhost:8888" });
  await adminApi.post("/__admin/toggle-by-path", {
    data: { instanceId: "api", path: mockPath, enabled },
  });
}

test.describe("Login Scenarios", () => {
  // Ensure the mock is disabled before and after the test
  test.afterEach(async () => {
    await setMock("account/locked_user.mock.js", false);
  });

  test("Shows account locked message correctly", async ({ page }) => {
    // 1. Enable the mock that returns HTTP 403 / Account Locked
    await setMock("account/locked_user.mock.js", true);

    // 2. Perform the action in our web/mobile app
    await page.goto("/login");
    await page.fill("#username", "testuser");
    await page.fill("#password", "wrongpass");
    await page.click("#login-btn");

    // 3. Validate that the UI reacted to the mock
    await expect(page.locator(".error-banner")).toContainText(
      "Your account has been locked"
    );
  });
});
```

### Example in **Cypress**

In Cypress, you can create a _Custom Command_ to communicate with the Mock Server.

**In `cypress/support/commands.js`:**

```javascript
Cypress.Commands.add("setServerMock", (instanceId, mockPath, enabled) => {
  cy.request("POST", "http://localhost:8888/__admin/toggle-by-path", {
    instanceId,
    path: mockPath,
    enabled,
  }).then((response) => {
    expect(response.status).to.eq(200);
  });
});

Cypress.Commands.add("loadMockProfile", (profileName) => {
  cy.request("POST", "http://localhost:8888/__admin/profiles/load", {
    name: profileName,
  });
});
```

**In your test (`cypress/e2e/vehicles.cy.js`):**

```javascript
describe("Vehicle Garage", () => {
  it("Should show an empty state when user has no vehicles", () => {
    // Enable the mock that returns an empty vehicles array
    cy.setServerMock("auth", "catalog/get-items.mock.js", true); // Assuming the mock returns []

    cy.visit("/garage");
    cy.contains("You have no vehicles saved.").should("be.visible");
    cy.get("button").contains("Add Vehicle").should("exist");

    // Clean up by disabling the mock
    cy.setServerMock("auth", "catalog/get-items.mock.js", false);
  });

  it("Should load the whole unhappy-path profile for stress testing", () => {
    // Load a previously saved profile with all error mocks enabled
    cy.loadMockProfile("all-errors-profile");
    cy.visit("/dashboard");
    cy.contains("Services unavailable at this time").should("be.visible");
  });
});
```

### Validating outgoing payloads with **Capture Sessions**

When the assertion is about **what the app sent** (not what the UI shows),
wrap the action in a capture session and assert on the captured request:

```typescript
import { test, expect } from "@playwright/test";
// Copy clients/js/capture-client.js into your repo:
const { CaptureClient } = require("./capture-client");

test("login sends the credentials payload exactly once", async ({ page }) => {
  const capture = new CaptureClient(); // autodetects the proxy port
  await capture.start({ name: "login-payload" });

  await page.goto("/login");
  await page.fill("#username", "testuser");
  await page.fill("#password", "secret");
  await page.click("#login-btn");

  const { requests } = await capture.stop();
  const logins = requests.filter((r) => r.path === "/api/login");
  expect(logins).toHaveLength(1);
  expect(logins[0].requestBody).toEqual({ user: "testuser", pass: "secret" });
});
```

Python (pytest) and Java (JUnit) equivalents live in
[clients/README.md](./clients/README.md).

---

### Why use the API in automated testing?

1. **Avoid Flakiness:** You don't depend on the actual the real QA or UAT server being up or having the specific data your test needs.
2. **Edge Cases:** You can easily test `500` errors, timeouts (using a mock's `delay` property), or locked account states without needing to manipulate the actual database.
3. **Concurrency:** The `profile:load` endpoint allows you to set the entire app (50+ endpoints) to a specific state (e.g., "New User", "Server Maintenance") with a single 10ms HTTP request before the UI test even begins.
