/**
 * proxy-server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * A system-level HTTP/HTTPS intercepting proxy that:
 *
 *  • Handles plain HTTP proxy requests (Proxy-Connection header style).
 *  • Handles HTTPS via HTTP CONNECT tunnels with selective MITM:
 *      - Hosts with SSL proxying enabled → TLS termination + mock pipeline.
 *      - Everything else                 → raw TCP pass-through (no decryption).
 *    SSL proxying is a per-host switch the user flips from the dashboard
 *    (store.hostSettings); see utils/interception.js for the predicate.
 *  • Records *every* host a device reaches for — tunneled ones included — so
 *    the dashboard can show what's out there before you decide to decrypt it.
 *  • Serves the dashboard on /__admin from any instance port.
 *  • Tries port 8888 first; auto-selects the next available port if busy —
 *    unless the occupant is another copy of this server, in which case it
 *    refuses to start (see findAvailablePort).
 */

"use strict";

const http = require("http");
const net = require("net");
const tls = require("tls");
const express = require("express");
const path = require("path");

const certManager = require("./utils/cert-manager");
const {
  createBlockMiddleware,
  createMockMiddleware,
  createProxyHandler,
} = require("./utils/mock-pipeline");
const { parsers: bodyParsers } = require("./utils/body-capture");
const createAdminRouter = require("./utils/admin-router");
const { createLoggerMiddleware } = require("./utils/request-log");
const {
  hostOf,
  parseConnectTarget,
  resolveInstanceForHost,
  shouldMitm,
} = require("./utils/interception");
const hostRegistry = require("./utils/host-registry");
const accessGate = require("./utils/access-gate");
const networkWatch = require("./utils/network-watch");
const sseHub = require("./utils/sse-hub");

const PREFERRED_PORT = 8888;
const MAX_PORT_SCAN = 20; // try up to PREFERRED_PORT + 20
const PROBE_TIMEOUT_MS = 500;

// Escape hatch for the rare case of deliberately running two proxies (separate
// mock sets, say). They will still share state.json — that is the reason this
// is opt-in rather than the default. Read per call, not captured at import, so
// it reflects the environment the caller actually has.
const allowMultiple = () => process.env.ALLOW_MULTIPLE_INSTANCES === "1";

// ── Port selection ────────────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "0.0.0.0");
  });
}

/**
 * Is whatever holds `port` another copy of *this* server?
 *
 * The distinction is the whole point. Port 8888 is very often already held by
 * another debugging proxy, and stepping around that is why the scan below
 * exists. A second copy of *us* is a different problem entirely: it would
 * happily take the next port and then share `state.json` with the first, where
 * the two clobber each other's writes — and nothing on screen would say so.
 * Same probe `scripts/cli.js` uses to find the live server.
 */
function isOurServer(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/__admin/health",
        method: "GET",
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json?.status === "ok" && Array.isArray(json.instances));
          } catch {
            // Anything that isn't our health payload — another proxy, a 404, HTML.
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function findAvailablePort(preferred) {
  for (let port = preferred; port <= preferred + MAX_PORT_SCAN; port++) {
    if (await isPortFree(port)) return port;
    if (!allowMultiple() && (await isOurServer(port))) {
      const err = new Error(`A mock proxy is already running on port ${port}.`);
      err.code = "EPROXYRUNNING";
      err.port = port;
      throw err;
    }
  }
  throw new Error(
    `No available port found between ${preferred} and ${preferred + MAX_PORT_SCAN}`
  );
}

// ── Express app for MITM'd HTTPS traffic ─────────────────────────────────────

/**
 * Build a minimal Express app that runs the full mock pipeline for a given
 * instance. This app is used as the TLS-terminated handler inside the CONNECT
 * tunnel when the target hostname matches a config entry.
 */
function buildInstanceApp(
  instance,
  store,
  MOCKS_DIR,
  STATE_FILE,
  serverConfigs,
  saveState
) {
  const app = express();
  const { id } = instance;

  // Reading the body without changing it, and without ever rejecting one the
  // upstream would have accepted — see utils/body-capture.js.
  bodyParsers().forEach((parser) => app.use(parser));
  app.use(
    createLoggerMiddleware(id, {
      targetUrl: () => store.instanceSettings[id]?.targetUrl,
    })
  );
  app.use("/__admin", express.static(path.join(__dirname, "public")));

  // Admin dashboard accessible from the proxy port too
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE,
      store,
      serverConfigs,
      saveState,
      instanceId: id,
    })
  );

  app.use(createBlockMiddleware(store, () => hostOf(instance.target)));
  app.use(createMockMiddleware(id, store, MOCKS_DIR));
  app.use("/", createProxyHandler(id, store, MOCKS_DIR));

  return app;
}

// ── Access approval ──────────────────────────────────────────────────────────

/**
 * Paths a device must reach *before* it can possibly be approved, plus the
 * approval routes themselves.
 *
 * The certificate files and the setup page are the bootstrap problem: gate them
 * and a phone can't install the CA, so it can't reach anything, so it can never
 * get to the point of asking. `/access/*` is here because it enforces loopback
 * itself — routed through the gate instead, a remote caller asking to approve
 * itself would appear as an ordinary "someone wants in" prompt.
 */
const UNGATED = [
  /^\/access(\/|$)/,
  /^\/proxy\/ca\.(pem|cer)$/,
  /^\/proxy\/network-security-config$/,
  /^\/proxy\/install-guide$/,
  /^\/proxy\/info$/,
];

/**
 * Hold an unknown machine's request until somebody at the keyboard answers.
 *
 * Deliberately reads `req.socket.remoteAddress` and nothing else.
 * `X-Forwarded-For` is a header — written by whoever is connecting — so trusting
 * it would let the caller name its own address and walk straight through.
 */
async function accessMiddleware(req, res, next) {
  const ip = accessGate.normalizeIp(req.socket.remoteAddress);
  if (accessGate.isLoopback(ip)) return next();
  if (UNGATED.some((re) => re.test(req.path))) return next();
  if (accessGate.isAllowed(ip)) return next();

  console.log(`🔔 [Access] ${ip} is asking to use ${req.originalUrl}`);
  const granted = await accessGate.request({
    ip,
    path: req.originalUrl,
    ua: req.headers["user-agent"],
  });

  if (granted) return next();
  res
    .status(403)
    .type("text/plain")
    .send(
      "This mock proxy only answers machines that have been approved.\n" +
        "Ask whoever is running it to allow this device from their dashboard.\n"
    );
}

// ── Startup banner ───────────────────────────────────────────────────────────

/**
 * The block of addresses to point devices at.
 *
 * A function rather than inline in the listen callback because it is printed
 * again whenever the machine's address changes — the whole point being that the
 * copy scrolled up the terminal is now wrong.
 */
function printBanner(proxyPort, addresses, { rebind = false } = {}) {
  // No external interface means nothing off-box can reach us, which changes both
  // what to print and whether the access note below applies at all.
  const reachableFromNetwork = addresses.length > 0;
  const localIPs = reachableFromNetwork ? addresses : ["localhost"];

  const separator = "─".repeat(60);
  console.log(`\n${separator}`);
  console.log(
    rebind
      ? `🔀 [Proxy] Still listening on port ${proxyPort} — new address:`
      : `🔀 [Proxy] HTTP/HTTPS proxy listening on port ${proxyPort}`
  );
  console.log(
    rebind
      ? `   Devices pointed at the old one need updating:`
      : `   Configure devices with:`
  );

  localIPs.forEach((ip, index) => {
    if (index > 0) console.log(`   ${"-".repeat(40)}`);
    console.log(`   • Server: ${ip}   Port: ${proxyPort}`);
    console.log(`   • Dashboard: http://${ip}:${proxyPort}`);
    console.log(
      `   • CA Installation: http://${ip}:${proxyPort}/__admin/proxy/install-guide`
    );
  });

  // Printed right under the LAN address, which is the moment the reader learns
  // this is reachable off-box.
  //
  // This used to be a warning that nobody was checking who called `/__admin`.
  // That stopped being true when the approval gate landed, and a warning that
  // overstates the danger is worse than none — it is the kind people learn to
  // scroll past. What replaced it is the part the reader genuinely cannot see
  // from here: which machines were approved in an *earlier* session and so get
  // in without anyone being asked again.
  if (reachableFromNetwork) {
    const remembered = accessGate.remembered();
    console.log(`${separator}`);
    console.log(`🔑 [Access] Other machines must be approved from this dashboard`);
    console.log(`   before they can use /__admin. The proxy port itself is open —`);
    console.log(`   they can route traffic through it and fetch the CA certificate,`);
    console.log(`   but not read your captures or change what you intercept.`);
    if (remembered.length) {
      console.log(
        `⚠️  ${remembered.length} device(s) approved earlier are let straight in:`
      );
      console.log(`     ${remembered.join(", ")}`);
      // Worth saying loudest right here: if this machine was renumbered, the
      // whole subnet probably was, and a remembered address now points at
      // whichever device inherited it.
      if (rebind) {
        console.log(`   The subnet moved — those addresses may be other devices now.`);
      }
      console.log(`   Review them in the dashboard: ⚙ → Approved devices.`);
    }
  } else {
    console.log(`${separator}`);
    console.log(`📴 [Network] No external interface — reachable from this machine only.`);
  }

  console.log(`${separator}\n`);
}

// ── HTTPS MITM handler ───────────────────────────────────────────────────────

function handleMITM(clientSocket, head, hostname, port, instanceServer) {
  const hostCert = certManager.getHostCert(hostname);

  // Upgrade the raw socket to a TLS socket using the dynamically signed cert
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: hostCert.key,
    cert: hostCert.cert,
  });

  // Stash the CONNECT target on the socket. Once we're inside the tunnel the
  // request's Host header is the only other clue, and it's neither guaranteed
  // nor trustworthy — the logger reads these back for the host/port fields.
  tlsSocket.__irProxyHost = hostname;
  tlsSocket.__irProxyPort = port;

  // `on`, not `once`. A TLS socket can error more than once — this very handler
  // destroys the socket under it, which is itself a good way to provoke a second
  // one — and after a `once` listener fires it is gone. An 'error' with no
  // listener on an EventEmitter throws, so the second one would take the whole
  // proxy down and every tester's session with it.
  tlsSocket.on("error", (err) => {
    console.error(`🔴 [Proxy MITM] TLS error for ${hostname}:`, err.message);
    clientSocket.destroy();
  });
  // The raw socket needs one too, for the same reason it has one on the tunnel
  // path: a client that vanishes mid-handshake errors here, not on the TLS side.
  clientSocket.on("error", () => tlsSocket.destroy());

  // Feed the TLS-terminated socket into the instance's shared HTTP server.
  // A single http.Server per instance handles every connection — the Express
  // mock pipeline is built once (see getInstanceApp) instead of per request.
  instanceServer.emit("connection", tlsSocket);

  if (head && head.length > 0) {
    tlsSocket.emit("data", head);
  }
}

// ── TCP Pass-through tunnel ───────────────────────────────────────────────────

function handlePassThrough(clientSocket, head, hostname, port) {
  const serverSocket = net.connect(port, hostname, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  // Silent on purpose, and the handler is still mandatory. A tunnel carries
  // every host the device reaches for, so these errors are the ordinary noise of
  // a phone on Wi-Fi — CDNs closing keep-alives, DNS misses, apps giving up on
  // HTTP/3 fallbacks — hundreds an hour, none of them actionable, and they used
  // to bury the startup banner and the access prompts that are. The tree already
  // shows every host that was reached. But the listener itself cannot go: an
  // 'error' with nobody listening on an EventEmitter throws, and that would take
  // the whole proxy down (see the socket-handler note in CLAUDE.md).
  serverSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => serverSocket.destroy());
  // pipe() only propagates a clean 'end' — an abrupt close (RST, dropped
  // Wi-Fi) leaves the peer socket dangling, so tear it down explicitly.
  serverSocket.on("close", () => clientSocket.destroy());
  clientSocket.on("close", () => serverSocket.destroy());
}

// ── Plain HTTP proxy ──────────────────────────────────────────────────────────

function handlePlainHTTP(req, res, serverConfigs, store, getInstanceApp) {
  // Parse the absolute URL from the request line (http://host/path)
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url);
  } catch {
    res.writeHead(400);
    return res.end("Bad Request");
  }

  const hostname = parsedUrl.hostname;

  // Record the host before deciding what to do with it, so a tunneled host is
  // just as discoverable as an intercepted one.
  hostRegistry.seen({
    host: hostname,
    port: Number(parsedUrl.port) || 80,
    protocol: "http",
  });

  const instance = resolveInstanceForHost(hostname, serverConfigs);

  if (shouldMitm(hostname, { serverConfigs, hostSettings: store.hostSettings })) {
    // Strip the absolute URL prefix so Express sees a relative path
    req.url = parsedUrl.pathname + (parsedUrl.search || "");
    // Dispatch straight into the instance's cached Express app — an app is
    // itself a (req, res) handler, so no per-request server allocation.
    getInstanceApp(instance).app(req, res);
  } else {
    // Forward transparently
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + (parsedUrl.search || ""),
      method: req.method,
      headers: { ...req.headers, host: parsedUrl.host },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => res.end());
    req.pipe(proxyReq);
  }
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Creates and starts the unified proxy server.
 *
 * @param {object} opts
 * @param {Array}    opts.serverConfigs
 * @param {object}   opts.store
 * @param {string}   opts.MOCKS_DIR
 * @param {string}   opts.STATE_FILE
 * @param {Function} opts.saveState
 * @param {number}   opts.preferredPort
 */
/**
 * How large a single call to the dashboard API may be.
 *
 * Not a limit on traffic — see `utils/body-capture.js` for that. This bounds the
 * JSON envelope the dashboard, the CLI and the clients post to `/__admin/*`,
 * which carries a composed request's whole body inside it.
 */
const ADMIN_JSON_LIMIT = 16 * 1024 * 1024;

async function startProxyServer({
  serverConfigs,
  store,
  MOCKS_DIR,
  STATE_FILE,
  saveState,
  preferredPort = PREFERRED_PORT,
}) {
  const proxyPort = await findAvailablePort(preferredPort);

  if (proxyPort !== preferredPort) {
    console.log(
      `⚠️  [Proxy] Port ${preferredPort} is in use — using port ${proxyPort} instead.`
    );
  }

  // Create Express app for direct requests (dashboard UI + admin API)
  const directAdminApp = express();
  // Well above anything the dashboard sends, on purpose. Express's default is
  // `100kb`, and a composed request carries its whole body inside this
  // envelope — so a payload of a hundred thousand characters, which is an
  // ordinary sync request for a real account, was refused before it ever
  // reached `/send`. This is the dashboard's own control plane on loopback, not
  // proxied traffic: the limits that should bind a body are the ones further
  // down that say something useful when they do (`MAX_PARSE_BYTES` decides
  // whether the log can see it, `request-store.MAX_BYTES` whether it can be
  // saved). This one only has to stop being the first wall.
  directAdminApp.use(express.json({ limit: ADMIN_JSON_LIMIT }));

  // Phones and tablets get the certificate setup page instead of the dashboard,
  // which is desktop-only. Registered BEFORE express.static, which would
  // otherwise answer "/" with index.html and never reach this.
  //
  // This only catches devices that announce themselves; iPadOS 13+ sends a
  // desktop macOS user agent, so index.html carries a client-side check too.
  directAdminApp.get("/", (req, res, next) => {
    if (req.query.desktop === "1") return next();
    const ua = req.headers["user-agent"] || "";
    const isMobile =
      req.headers["sec-ch-ua-mobile"] === "?1" ||
      /Android|iPhone|iPad|iPod|Windows Phone|Mobile Safari/i.test(ua);
    if (!isMobile) return next();
    res.redirect(302, "/install-guide.html");
  });

  directAdminApp.use(express.static(path.join(__dirname, "public")));

  directAdminApp.use("/__admin", accessMiddleware);

  // Mounted unconditionally, and that matters: with an empty `instances` list —
  // which is what a fresh clone boots with, and what removing your last host
  // leaves you with — a guarded mount serves the dashboard's HTML from the
  // static handler above and then 404s every call it makes. The page comes up
  // dead, with no tree, no config, and no way to add the instance that would
  // bring the API back. `serverConfigs` is read live on every request, so the
  // router built here picks up instances added later without a restart.
  //
  // `instanceId` is only the *default scope* for `/config`'s
  // `currentInstanceId`, which the mock matrix uses to highlight a column.
  // With no instances there is no column to highlight, and null says so.
  directAdminApp.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE,
      store,
      serverConfigs,
      saveState,
      instanceId: serverConfigs[0]?.id ?? null,
    })
  );

  // Redirect /__admin to /
  directAdminApp.get("/__admin", (req, res) => {
    res.redirect("/");
  });

  // Body-parser failures reach here, and Express's default handler answers them
  // with an HTML error page. Every caller of this API — the dashboard, the CLI,
  // the three drop-in clients — reads `{ error }` out of JSON, so an HTML body
  // arrives as a parse failure with nothing in it: the request looked like it
  // had been cut rather than refused, which is a much worse thing to debug.
  directAdminApp.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === "entity.too.large") {
      return res.status(413).json({
        error:
          `Request is too large — the dashboard API accepts up to ` +
          `${Math.floor(ADMIN_JSON_LIMIT / 1024 / 1024)} MB per call.`,
      });
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body is not valid JSON" });
    }
    const status = err?.status || err?.statusCode || 500;
    return res.status(status).json({ error: err?.message || "Internal error" });
  });

  // ── Per-instance app cache ──────────────────────────────────────────────
  // Build each instance's Express app + its wrapping http.Server exactly once
  // and reuse them across every request/connection. Previously these were
  // rebuilt on every request, which was the proxy's biggest source of churn.
  const instanceApps = new Map(); // id -> { app, httpServer }
  const getInstanceApp = (instance) => {
    let entry = instanceApps.get(instance.id);
    if (!entry) {
      const app = buildInstanceApp(
        instance,
        store,
        MOCKS_DIR,
        STATE_FILE,
        serverConfigs,
        saveState
      );
      entry = { app, httpServer: http.createServer(app) };
      instanceApps.set(instance.id, entry);
      console.log(`🧩 [Proxy] Built mock pipeline for "${instance.id}" (cached).`);
    }
    return entry;
  };

  /**
   * Drop an instance's cached app and close its wrapping http.Server.
   * Without this, removing an instance leaves a live server object behind for
   * the lifetime of the process — harmless while nothing routes to it, but a
   * leak once instances come and go at the user's whim.
   */
  const evictInstanceApp = (id) => {
    const entry = instanceApps.get(id);
    if (!entry) return false;
    instanceApps.delete(id);
    try {
      entry.httpServer.close();
    } catch {
      /* already closed */
    }
    console.log(`🧹 [Proxy] Evicted cached mock pipeline for "${id}".`);
    return true;
  };

  const server = http.createServer((req, res) => {
    // Plain HTTP proxy request (non-CONNECT)
    if (req.url.startsWith("http://") || req.url.startsWith("https://")) {
      handlePlainHTTP(req, res, serverConfigs, store, getInstanceApp);
    } else {
      // Direct request (dashboard UI + admin API) — an Express app is itself a
      // (req, res) handler, so dispatch directly without wrapping it per call.
      directAdminApp(req, res);
    }
  });

  // HTTPS CONNECT handler
  server.on("connect", (req, clientSocket, head) => {
    const { hostname, port } = parseConnectTarget(req.url);

    // Every HTTPS host a device reaches for passes through here, intercepted or
    // not — the one place where the full picture is available. Record it before
    // the branch so tunneled hosts are discoverable too.
    hostRegistry.seen({ host: hostname, port, protocol: "https" });

    const instance = resolveInstanceForHost(hostname, serverConfigs);

    if (shouldMitm(hostname, { serverConfigs, hostSettings: store.hostSettings })) {
      // Send 200 first, then begin TLS handshake
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      handleMITM(clientSocket, head, hostname, port, getInstanceApp(instance).httpServer);
    } else {
      // Raw TCP tunnel — no decryption
      handlePassThrough(clientSocket, head, hostname, port);
    }
  });

  server.on("error", (err) => {
    console.error("🔴 [Proxy] Server error:", err.message);
  });

  server.listen(proxyPort, "0.0.0.0", () => {
    // Publish the bound port so the admin router can loop replayed requests
    // back through this proxy (see POST /__admin/replay).
    store.proxyPort = proxyPort;

    printBanner(proxyPort, networkWatch.localIPs());

    // The address above is what every device has typed into its proxy settings,
    // so when the router hands out a different one the banner is stale and every
    // phone is pointing at nothing. Reprint it, and tell the dashboard.
    networkWatch.start({
      onChange: ({ from, to }) => {
        console.log(`\n🔄 [Network] This machine's address changed.`);
        console.log(`   was: ${from.join(", ") || "(none)"}`);
        printBanner(proxyPort, to, { rebind: true });
        sseHub.broadcast("network", { localIPs: to, port: proxyPort, previous: from });
      },
    });
  });

  return { server, port: proxyPort, evictInstanceApp };
}

module.exports = { startProxyServer };
