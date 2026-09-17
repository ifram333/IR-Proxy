# IR Proxy

A robust, enterprise-grade mock proxy server designed for QA, automated testing, and local development. It intercepts API requests to multiple backend targets and overrides them with customized local responses (mocks), allowing you to simulate edge cases, errors, latency, and specific data scenarios without relying on actual backend environments.

> 📚 **Docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) (how it works) · [CONTRIBUTING.md](./CONTRIBUTING.md) (dev workflow) · [API_USAGE_GUIDE.md](./API_USAGE_GUIDE.md) (CLI & API) · [docs/ROADMAP.md](./docs/ROADMAP.md) (known holes)

---

## 🖥️ The Dashboard

The dashboard is a **traffic workspace**, served by the proxy at its root. It is
**desktop-only** — phones and tablets are redirected to a certificate-setup page
instead (see below).

```
┌─ app bar ───────────────────────────────────────────────┐
├─ hosts ────────┬┬─ requests for the selected node ──────┤
│ ★ Focused      ││ 10:42  GET  /v1/offers   200   142ms  │
│ ▾ 🔒 api.x.com ││ 10:41  GET  /v1/offers   200   1.2s   │
│    ▾ v1        │├────────── drag to resize ─────────────┤
│      offers ×2 ││ [ Request | Response ]                │
│   All hosts    ││  Query · Headers · Body               │
│ ▸ 🔓 cdn.x.com ││  { … }                                │
│   Ignored (4)  ││                                       │
└────────────────┴┴───────────────────────────────────────┘
```

### Everything your device talks to

The proxy records **every host** a connected device reaches for, whether or not
it decrypts it. Point a phone at the proxy and its hosts appear in the left
panel immediately — that's how you find out what an app is actually calling.

A host you haven't enabled shows a 🔓 and a **connection** count. It is tunneled
untouched: nothing is decrypted, nothing is logged in detail, and a
certificate-pinned app keeps working normally.

### SSL proxying, per host

Right-click a host to **Enable SSL Proxying**. From the next connection on, the
proxy terminates TLS for it, its requests appear as a path tree, and its mocks
can run. The padlock turns 🔒 and the counter switches to **requests**.

The rest of the host menu:

| Action                      | What it does                                                |
| --------------------------- | ----------------------------------------------------------- |
| Enable/Disable SSL Proxying | Decrypt this host, or go back to tunneling it               |
| Focus / Unfocus / Ignore    | Move it into the ★ Focused section, back, or out of the way |
| Open mocks                  | Show that host's mocks in the right panel                   |
| Clear this host's log       | Drop only this host's captured requests                     |
| Remove host from list       | Forget it entirely (its mocks are kept)                     |

> ⚠️ Enabling SSL for a host whose app **pins its certificate** will break that
> app's networking until you turn it back off. The dashboard warns you first.

A fresh clone boots with **no targets at all** — `state.example.json` seeds an
empty list, because the hosts worth intercepting are whatever _your_ project
talks to. Point a device at the proxy and every host it reaches for shows up in
the tree, recorded but not decrypted; turn SSL proxying on for the ones you want
to mock. Nothing is decrypted until you say so.

### The tree

Root is the host, each branch is a path segment, each leaf is an endpoint. An
endpoint called 200 times stays **one** row badged `×200` — selecting it lists
all 200 calls in the panel on the right. Right-click a leaf for:

- **Retry** — re-send that request through the full pipeline; the replay lands
  back in the log flagged `↻`.
- **Create mock** — generate a `.mock.js` from the captured response and open it
  in the editor.

### Sending your own requests

**→ New request** in the header (or `⌘⌥R`) opens the same editor empty: pick an
intercepted host, set method, path, headers and body, send. The result lands in
the log flagged `→`, next to the traffic from your devices.

It goes **through the proxy**, not straight at the upstream — so your mocks
answer it, your injected latency applies, and the "fail all requests" switch
applies. That is the part a separate API client can't do: it isn't the proxy, so
it can't know about your instances or show you the call in the same timeline.

Only hosts with SSL proxying on can be sent to; the rest appear in the picker
greyed out as `— SSL off`, because a tunneled host would go straight upstream
with nothing mocked and nothing logged.

**Save** keeps the request under a name, and the picker in the modal's top-right
loads it back. It works from Retry too, which is how "this is the login call,
I'll want it again" gets recorded off real traffic. Saving under a name that
already exists updates it — the prompt says so before you commit.

Saved requests are files in `requests/`, one per request, **gitignored on
purpose**: they store request headers, and that is where `Authorization` lives.
Committing one would put a token in the repo's history.

### Collections

**📁 Collections** in the header is the screen for everything you have saved:
named groups on the left of nothing, one row per request, each one sendable on
the spot.

A collection is an **ordered** list, because that is what these have — "log in,
then call the thing that needs the token". **Run all** (`▷▷` on the group) walks
it top to bottom, one request at a time, waiting for each before starting the
next, and writes the status and duration onto every row as it goes. It does not
stop at the first failure: a run is how you find out _where_ a flow breaks, and
the rows after the red one are part of that answer. **Stop** ends it after the
request already on the wire.

The run is just the composer's Send, repeated in order, so each call meets your
mocks, your latency and the 503 switch, and lands in the activity log next to
the device traffic — you can watch a run fill the tree on the left as it goes.
A row whose host has SSL proxying off shows a red ✕ saying so, and the run
carries on.

**Drag a request** to reorder it or move it to another collection — the same
drag the mock matrix uses to move a mock into a folder, except a request also
needs a _position_: drop on the top half of a row to land before it, the bottom
half to land after it, or anywhere else in a group to append. _Ungrouped_ is
always shown so there is somewhere to drag one out to.

Right-click a request to open it in the editor, move it up or down, move it to
another collection, or delete it. Right-click a group to rename it or delete it
— deleting a collection **keeps** its requests, they go back to _Ungrouped_,
which is also where everything saved before you made any collection already
sits. Composing from inside a group (`＋`) saves into that group.

The groups live in `requests/_collections.json` and hold nothing but names and
ordered ids, so moving a request between collections never rewrites the file
holding its body and headers.

#### Checking the response

A run that only reports `200` tells you the call went out, not that it came back
right — an endpoint answering `200` with `{"error": …}`, or missing a field your
app needs, reads exactly like a healthy one.

The request editor's **Expect** tab is where you say what a good answer looks
like: an expected status, a JSON Schema for the body, or both. It is checked on
every send — from a run, from `▷` on a row, from the editor's own Send button —
and it is stored with the request, so the check travels with it.

```json
{
  "type": "object",
  "required": ["id", "items"],
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": ["string", "null"] },
    "items": { "type": "array", "minItems": 1 }
  }
}
```

A row that passed reads `200 ✓`; one that failed reads `200 ✗` in red, with
every problem — `/items: expected at least 1 items, got 0` — in its tooltip, and
it counts as a failure in the run summary. The status stays on screen either
way, because "500" and "200 of the wrong shape" are different findings. Rows
that carry a check are marked `{ }`, so a green run of requests that assert
nothing can't be mistaken for a passing suite. A failed check does **not** stop
a run, for the same reason a 500 doesn't.

Sending from the editor with a failing expectation **keeps the modal open** and
lists the problems, rather than closing on what looks like a success.

The editor's **Variables** tab holds `{"name": "value"}`, and the path, the
header values and the body can use them:

```
/orders/{{ orderId }}?q={{ query | encodeURIComponent }}
authorization: Bearer {{ token }}
```

Inside a **JSON body**, a variable that stands for a value needs to arrive
quoted — `{"ref": "{{ id }}"}` or, if you would rather not quote it by hand,
`{"ref": {{ id | json }}}`. Substituting bare (`{"ref": {{ id }}}`) produces text
that is no longer JSON, which the receiving service will reject rather than
misread.

Filters are piped and come from a closed list — `encodeURIComponent`,
`encodeURI`, `base64`, `json`, `trim`, `uppercase`, `lowercase` — and anything
else is refused by name, as is `{{ encodeURIComponent(q) }}`: there is no
expression evaluation here, only substitution. **An undefined variable is an
error, not an empty string**, because a request that goes out with a blank token
comes back 401 and tells you nothing.

They resolve **on the server**, just before the request leaves, so a saved
request run from the CLI or from a suite resolves exactly the way it does in the
dashboard. A run can supply variables of its own, merged over the stored ones —
which is how the token stays out of the file:

```bash
npm run mock -- run --collection checkout-flow --var token=$QA_TOKEN --var id=42
```

`--var` is repeatable and, unlike `--schema-file`, applies to **every** request
in the run: a schema is a statement about one specific response, a token is an
input the whole flow needs. The same thing over HTTP:

```bash
curl -s -X POST http://localhost:8888/__admin/saved-requests/get-order/send \
  -H "Content-Type: application/json" \
  -d '{"variables": {"token": "'"$QA_TOKEN"'"}}'
```

The Expect pane can also **save the schema as a file** in `schemas/`, and load
one back. That is what stops a check from existing only inside one saved request
on one laptop: the file is plain JSON Schema, so it is what `--schema-file` and
CI read, what you paste out of your API's docs, and what shows up in a diff when
somebody changes what the API is allowed to return. It is saved through the same
validator a run uses, so a schema that could never be honoured is refused while
you are still looking at it. Unlike `requests/`, `schemas/` is **committed** — a
saved request carries `Authorization`, a schema carries the contract.

The same run is available **from the shell and from a test suite**, which is
what makes a collection something CI can gate on:

```bash
npm run mock -- run --collection checkout-flow     # exits non-zero on failure
npm run mock -- run --request get-order --schema-file ./schemas/order.schema.json
npm run mock -- checks                             # what actually asserts anything
```

```js
await new SchemaClient().assertCollectionPasses("checkout-flow");
```

Drop-in clients for JS, Python and Java live in [`clients/`](./clients) —
`assertPasses` **throws on a request that checks nothing** rather than returning
green, and so does the CLI's separate `unchecked` count. See
[clients/README.md](./clients/README.md#checking-responses--schema-clients).

This is a **subset** of JSON Schema: `type`, `required`, `properties`, `items`,
`additionalProperties`, `enum`, `const`, `minimum`/`maximum`,
`minLength`/`maxLength`, `minItems`/`maxItems` and `pattern`. Anything else —
`$ref`, `allOf`/`anyOf`/`oneOf`, `format` — is **refused by name the moment you
save it**, rather than ignored. A validator that quietly skips the keyword
holding your actual constraint would report green for a response it never
looked at, which is worse than having no check at all.

### Blocking a service

Right-click any path in the tree — a folder or an endpoint — and choose
**Block this path**. From then on, calls to it **die**: the connection is
destroyed and nothing is answered, which is what a service that is genuinely
down looks like to your app. Blocked paths wear a red **BLOCK** tag in the tree,
in the same place the `MOCK` and `PROXY` tags appear, whether or not anything has
hit them since.

This is not the same as the inspector's _Fail all requests (503)_ switch, and not
the same as a mock returning an error. Those are **responses** — a client that
handles them has not been shown what the network failing looks like. Blocking is
the only one that takes the connection away.

A rule covers everything beneath it, so blocking `/orders` also blocks
`/orders/42` — and not `/orders-archive`, which merely starts the same way.
Children of a blocked path show the tag too, and their menu offers to lift the
rule that actually covers them by name, rather than a no-op on themselves.

Blocked calls still appear in the activity log, tagged `BLOCK` with no status, so
you can prove the block fired rather than wondering whether the proxy broke.

The same thing is available without the dashboard — from the shell:

```bash
npm run mock -- block   --host api.example.com --path /orders
npm run mock -- blocks  --host api.example.com --path /orders/42   # would it die?
npm run mock -- unblock --host api.example.com --path /orders
npm run mock:blocks                                                # everything
```

…and from a test suite, via the drop-in **block clients** for JS, Python and Java
(`clients/`), which can kill a service for the duration of one test and put the
host's rules back afterwards. See
[clients/README.md](./clients/README.md#blocking-requests--block-clients).

**Blocking needs SSL on for the host.** The rule runs inside the decrypted
pipeline, so a tunneled host stores it and never fires it. The CLI says so, and
the clients throw rather than let a test assert against a rule that cannot act.

### The inspector

Selecting a **host or folder** shows its host, port, protocol, path, upstream
and counters. Selecting an **endpoint** shows every call to it, and for the one
you pick: method, status, duration, source (`MOCK` / `PROXY` / `INTERCEPT` /
`OFF`), path, then **Request** (query params, headers, body) and **Response**
(headers, body) as tabs, rendered as a collapsible JSON tree.

Also there: find-in-request/response (`⌘F`), copy any section, **Copy as cURL**,
and **Create Mock**.

Both dividers are draggable, and the sizes you choose are remembered.

### Mocks

Mocks live per host — right-click → **Open mocks**. If SSL proxying is off for
that host, a banner says so plainly, because a mock on a tunneled host can never
run. **All mocks** in the header keeps the cross-host matrix, so you can still
see at a glance that a mock is ON for one target and OFF for another.

Next to each switch is **how many requests that mock has answered** this run, so
_"did it actually fire?"_ is a glance rather than a hunt through the log. A muted
`·` means it's enabled and has answered nothing yet — usually the interesting
one. Counts are per host, live, and survive clearing the activity log; right-click
a host column to reset them.

### Other controls

The ⚙ popover holds the standalone-server toggle, scenario profiles, **Approved
devices** (see the security note below), and the "add a host" box (adding a
target explicitly turns SSL proxying on for it).

Live traffic streams over Server-Sent Events on `/__admin/events` — one
connection carrying both request entries and host updates. Press `/` to focus
the filter and `?` for the keyboard shortcuts.

### Phones and tablets

Opening the dashboard from a phone or tablet redirects to
`/install-guide.html`: your device's proxy settings with the real IP and port,
the right certificate for your OS, step-by-step install instructions, and a
button that checks whether it actually worked. Add `?desktop=1` to load the
dashboard anyway.

## 🔐 Certificate Installation Guide

To intercept HTTPS traffic, you must configure your device to use the proxy server and trust the Root Certificate Authority (CA) certificate.

Below are the step-by-step installation instructions for each platform. You can download certificates directly from the header of the web dashboard.

### 🍎 macOS

1. **Download Certificate**: Download the `ir-proxy-ca.pem` certificate from the dashboard.
2. **Install to Keychain**: Double-click the downloaded `.pem` file to open **Keychain Access**.
3. **Locate & Open**: Find the entry **IR Proxy CA**, double-click it.
4. **Set Trust**: Expand the **Trust** section, change the settings for _When using this certificate_ to **Always Trust**.
5. **Save**: Close the dialog and enter your macOS administrator password to apply.
6. **Set Proxy**: Navigate to _System Settings ➔ Wi-Fi ➔ Details ➔ Proxies_. Enable **HTTP Proxy** and enter the proxy's server IP and port.

### 🪟 Windows

1. **Download Certificate**: Download the `ir-proxy-ca.pem` certificate and rename the file extension to `.crt` (e.g., `ir-proxy-ca.crt`).
2. **Install Certificate**: Double-click the file and click **Install Certificate**.
3. **Store Location**: Choose **Local Machine**, then select **Place all certificates in the following store**.
4. **Select Store**: Click **Browse** and select **Trusted Root Certification Authorities**. Click OK and then Finish.
5. **Command Line Option**: Alternatively, open an Administrator Command Prompt and run:
   ```cmd
   certutil -addstore root ir-proxy-ca.crt
   ```
6. **Set Proxy**: Go to _Settings ➔ Network & Internet ➔ Proxy_. Under _Manual proxy setup_, enable the proxy, and enter the server IP and port.

### 🤖 Android

1. **Download Certificate**: Open the dashboard on your device's browser and download `ir-proxy-ca.pem`.
2. **Install CA**: Open _Settings ➔ Security ➔ Encryption & Credentials ➔ Install a Certificate ➔ CA Certificate_. Select the downloaded file and confirm.
3. **Set Proxy**: Long-press your connected Wi-Fi network ➔ _Modify Network ➔ Advanced Options ➔ Proxy ➔ Manual_. Enter the server IP and port.
4. **Android 7+ (API 24+) Configuration**: Android apps ignore user-installed CA certificates by default. To bypass this for a development build:
   - Download the preconfigured `network_security_config.xml` file from the dashboard's Android tab or the endpoint `/__admin/proxy/network-security-config`.
   - Place it at `app/src/main/res/xml/network_security_config.xml`.
   - Reference this config in your `AndroidManifest.xml` within the `<application>` tag:
     ```xml
     android:networkSecurityConfig="@xml/network_security_config"
     ```
     > [!WARNING]
     > Make sure to revert this configuration before publishing to production.

### 📱 iOS (iPhone / iPad)

1. **Download Certificate**: On the iOS device, open **Safari** (other browsers may fail to download configuration profiles) and navigate to `http://<proxy-ip>:<port>/__admin/proxy/ca.cer`.
2. **Download Profile**: Tap **Allow** when prompted to download the Configuration Profile.
3. **Install Profile**: Open **Settings** on your iOS device. You will see a banner _Profile Downloaded_ at the top. Tap it, then click **Install** in the top right. Enter your passcode to confirm.
4. **Enable Certificate Trust**: Navigate to _Settings ➔ General ➔ About ➔ Certificate Trust Settings_. Enable the toggle to **Enable full trust for root certificates** for the _IR Proxy CA_.
5. **Set Proxy**: Open _Settings ➔ Wi-Fi_, tap the info `(i)` button next to your connected network, scroll to the bottom, tap _Configure Proxy ➔ Manual_, and input the proxy IP and port.

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- npm

### Installation

1. Clone this repository.
2. Install the dependencies:
   ```bash
   npm install
   ```

### Running the Server

Start the server in development mode (with `nodemon` for auto-restarts on core file changes):

```bash
npm run dev
```

Or start in production mode:

```bash
npm start
```

### If the address changes

A router reboot or an expired DHCP lease can hand this machine a different
address, and every device you configured is then pointing at nothing — with
nothing on screen to say so. The proxy watches for it: the startup banner is
**reprinted** with the new address, and the dashboard updates its header badge
and tells you, so you know to re-point the devices.

A remembered device approval is keyed by address, so if the subnet was renumbered
the banner says so too — check **⚙ → Approved devices**.

### Memory

The activity log is where this process's memory goes. The header shows what it's
holding — click it to **pause recording** without touching the proxy: traffic
keeps flowing and mocks keep firing, nothing is kept. That's what you want before
pushing a load test through it.

| Variable                   | Default   | What it does                                                                                                                      |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `IR_PROXY_LOG_SIZE`        | `1000`    | Requests retained before the oldest are dropped                                                                                   |
| `IR_PROXY_BODY_CHARS`      | `262144`  | Where each request/response body is truncated                                                                                     |
| `IR_PROXY_MAX_PARSE_BYTES` | `5242880` | Largest request body read into memory; bigger ones are forwarded unparsed (and so are invisible in the dashboard) — never refused |

### How big a body can be

Nothing here refuses a request for being large except the last row, which says so
in a sentence. Measured end to end on the real proxy:

| Up to  | What still works                                                   |
| ------ | ------------------------------------------------------------------ |
| 256 KB | everything — the body shows **whole** in the inspector             |
| 512 KB | sending, and the log keeps a 256 KB excerpt flagged `truncated`    |
| 5 MB   | sending; past 512 KB it can no longer be **saved** as a request    |
| 16 MB  | sending; past 5 MB nothing reads it, so it is invisible in the log |

Raise the first two with `IR_PROXY_BODY_CHARS` and the third with
`IR_PROXY_MAX_PARSE_BYTES`. The 512 KB save limit is `MAX_BYTES` in
`utils/request-store.js`, and it answers `413` with the number in the message.
The 16 MB ceiling is the dashboard API envelope (`ADMIN_JSON_LIMIT` in
`proxy-server.js`) — it exists so something bounds the call, not to bind a body.

Measured on the real proxy path, with 1000 entries whose responses all exceed
the cap: **127 MB held / 344 MB RSS** at a 128 KB cap, **252 MB / 481 MB** at
256 KB. Doubling the cap doubles what is held, and nothing else — the bodies are
copied out on truncation, so what the log costs follows this setting rather than
the size of the responses going through it. **Raising `IR_PROXY_LOG_SIZE` is not
free** either, and that cost isn't mainly memory — the hits table renders from
this log and the dashboard loads all of it, so the bill lands in the DOM first. For long soak runs,
lower it (`IR_PROXY_LOG_SIZE=200 npm start`) or pause recording. The biggest lever of
all is SSL proxying: a tunneled host buffers nothing at all.

**Run it under a supervisor if a team depends on it.** Dead sockets are caught
and shrugged off, but an unexpected exception is logged and the process exits
non-zero on purpose — swallowing one would leave the proxy in a state nobody has
reasoned about. `npm run dev` already restarts via nodemon; for anything
longer-lived use `pm2`, a `systemd` unit, or a `while true` wrapper.

### Accessing the Dashboard

Once running, open your browser and navigate to:

- **http://localhost:8888/** — or whichever port the proxy printed at startup.
  Port 8888 is often already held by another proxy, in which case it lands on 8889.

The dashboard needs a desktop-sized window. Opening that URL from a phone or
tablet redirects to `/install-guide.html`, which walks through pointing the
device at the proxy and trusting its certificate; append `?desktop=1` to load
the dashboard regardless.

---

## 📁 Project Structure

```
.
├── config.js               # Proxy settings only — no targets
├── state.example.json      # Versioned seed (no targets): copied to state.json on first boot
├── server.js               # Entry point: state, CA, standalone tier, starts the proxy
├── proxy-server.js         # The unified proxy: CONNECT, MITM, tunneling, dashboard host
├── store.js                # Global in-memory state (toggles, settings, host prefs, profiles)
├── state.json              # Runtime state: every host/instance, one entry each
├── API_USAGE_GUIDE.md      # Detailed documentation for CLI, cURL, and Testing Frameworks
├── public/
│   ├── index.html          # The desktop dashboard shell
│   ├── install-guide.html  # Certificate setup page for phones and tablets
│   └── js/modules/         # One module per panel: tree, inspector, mocks, editors…
├── scripts/
│   └── cli.js              # Command Line Interface logic
├── utils/
│   ├── interception.js     # The pure "decrypt or tunnel?" predicate (unit-tested)
│   ├── host-registry.js    # Every host the devices reach for, decrypted or not
│   ├── sse-hub.js          # One SSE connection shared by several producers
│   ├── admin-router.js     # Shared context + mount order for /__admin
│   ├── admin/              # One module per /__admin domain (hosts, mocks, send…)
│   ├── instance-manager.js # Adds/removes/promotes intercepted instances at runtime
│   ├── mock-loader.js      # Handles loading, caching, and hot-reloading of .mock.js files
│   └── request-log.js      # Request/response capture + history
├── mocks/                  # Your .mock.js definitions — contents gitignored
├── schemas/                # Your *.schema.json response contracts — committed
└── requests/               # Saved composer requests — contents gitignored
```

---

## 🛠️ Creating Mocks

Mocks are defined as `.mock.js` files inside the `mocks/` folder. You can organize them into subfolders (e.g., `mocks/auth/login.mock.js`).

**Basic structure of a mock file:**

```javascript
module.exports = {
  name: "Account Locked", // Human-readable name for the UI
  delay: 500, // Optional: Artificial latency in milliseconds

  // Condition to match incoming requests
  match: (req) => {
    return req.path.includes("/api/v1/auth/login") && req.method === "POST";
  },

  // The response to send when the mock is active
  respond: (req, res) => {
    res.status(403).json({
      error: "Your account has been locked due to multiple failed attempts.",
    });
  },
};
```

---

## 💻 CLI Usage

The project includes a robust CLI for interacting with the server.

```bash
# View server health
npm run mock:health

# List all mocks and their current status
npm run mock:list

# Toggle a mock
npm run mock -- toggle --instance api --mock "Account Locked" --on

# Load a saved profile
npm run mock -- profile:load --name "error-scenarios"

# Kill a service — the connection dies, unanswered (see "Blocking a service")
npm run mock -- block --host api.example.com --path /orders
npm run mock:blocks
```

For more CLI commands, cURL examples, and testing automation scripts (Playwright/Cypress), please refer to the [API_USAGE_GUIDE.md](./API_USAGE_GUIDE.md).

---

## 🎯 Capture Sessions (Test Automation)

Automated tests can mark a **start**, drive the app through the proxy, mark an
**end**, and assert on the exact requests the app sent in that window — full
method, path, headers, and parsed JSON body:

```bash
curl -X POST localhost:8889/__admin/capture/start   # → { sessionId }
# ... the app makes its calls through the proxy ...
curl -X POST localhost:8889/__admin/capture/stop \
  -H "Content-Type: application/json" -d '{"sessionId":"..."}'  # → { requests: [...] }
```

Standalone, dependency-free client helpers for **JavaScript, Python, and
Java** live in [`clients/`](./clients/README.md), along with the full endpoint
contract and per-language examples.

---

## 🛡️ Security Note

> **Run this on a network you trust.** The proxy listens on `0.0.0.0` so devices
> can reach it. `/__admin` has no password — instead, a machine that isn't yours
> has to be **approved from the dashboard** before it can use it.

### Device approval

The first time a machine other than this one calls `/__admin`, its request is
**held** and a prompt appears in your dashboard with the address, the path it
asked for and how it identifies itself. Allow it, deny it, or leave it — an
unanswered request is denied after 60 seconds.

The whole thing rests on one asymmetry: **loopback is the only trusted channel.**
Being on the machine already implies the power, so your own dashboard and CLI
never ask, and `/__admin/access/*` — where decisions are made — refuses anyone
else outright. Otherwise a caller could simply approve itself.

- **Approval is per machine, not per request.** A dashboard fires several calls
  at once; they all wait on one prompt.
- **"Remember this address" is opt-in.** Without it the approval lasts until the
  proxy restarts. Addresses get reassigned by DHCP, so a remembered one can
  quietly become a different device — re-check the list now and then.
- **⚙ → Approved devices** lists everything currently allowed, marks which
  entries survive a restart, and revokes them one at a time or all at once. A
  revoked device is asked again on its next request. Remembered addresses live in
  `state.json` under `proxy.allowedClients`; `DELETE /__admin/access/<ip>` is the
  same action from a script.
- **`X-Forwarded-For` is ignored.** It's a header, written by whoever is
  connecting; only the real socket address counts.
- **The certificate routes stay open** — `/__admin/proxy/ca.pem`, `/ca.cer`,
  `/network-security-config`, `/install-guide`, `/info`, and the setup page
  itself. A phone can't install the CA otherwise, so it could never reach the
  point of asking. Those expose the CA certificate (public by design) and the
  proxy's own address and port.
- **The proxy port is not gated.** Blocking `CONNECT` would cut a device off
  mid-test with no error anyone could interpret. Anyone on the network can still
  route traffic _through_ the proxy; they just can't read yours or reconfigure it.

**This is authorization, not authentication.** It raises the bar from "anyone on
the network" to "someone had to click Allow", which is real — but anyone sharing
your NAT inherits an approval for as long as it lasts, and an address is not an
identity. On genuinely hostile networks, don't run it.

**What an approved caller on the same network can do:**

| Endpoint                                     | What it exposes                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /__admin/log-history`                   | **Every captured request in full** — `Authorization` headers, cookies, request and response bodies. This is the one that matters: it's the credentials of whatever app you're debugging. |
| `GET /__admin/config`, `/hosts`, `/profiles` | Your intercepted targets, mock configuration and observed hosts                                                                                                                          |
| `POST /__admin/instances`, `/hosts/ssl`      | Add targets and switch **SSL proxying on for arbitrary hosts**                                                                                                                           |
| `POST /__admin/replay`                       | Re-send any captured request, with edits                                                                                                                                                 |
| `POST /__admin/save-mock`, `/delete-mock`    | Write and delete `.mock.js` files under `mocks/` (path-traversal is blocked, the directory is not)                                                                                       |

**Practical guidance**

- **Read the prompt before clicking Allow.** It is the whole mechanism. An
  address you don't recognise on shared Wi-Fi is a stranger, not a glitch.
- Fine on a home or personal-hotspot network, or with the machine firewalled to
  the device under test.
- On shared office or conference Wi-Fi, deny what you don't recognise and stop
  the proxy when you're not using it.
- **Never** port-forward or expose it to the internet.
- Enabling SSL proxying for a host means its decrypted traffic — tokens
  included — is held in memory and served over that open API. Turn it off for
  hosts you aren't actively debugging, and use **Clear this host's log** when
  you're done.
- `certs/ca.key` is the proxy's private CA key. It never leaves the machine and
  is gitignored — keep it that way. Anyone holding it can impersonate any site
  to a device that trusts your CA. It is created `0600`, and a key generated
  before that was enforced gets tightened on the next boot with a warning. If
  yours was world-readable on a shared machine, regenerate it: delete `certs/`,
  restart, and re-install the new CA on your devices.
- Values that clients can name — instance names, profile names — are validated
  server-side and rendered as text, never markup. That matters more than it
  sounds while `/__admin` is open: otherwise anyone on the network could store a
  name that runs code in the dashboard, which is the page that can read every
  decrypted request.

If you need more than this, the next step up is a token in `state.json` checked
alongside the approval gate — same loopback bypass, same certificate-setup
allowlist — so that CI and scripts get a credential rather than an address.
