const express = require("express");
const path = require("path");
const fs = require("fs");

const { proxy: proxyConfig } = require("./config");
const {
  createBlockMiddleware,
  createMockMiddleware,
  createProxyHandler,
} = require("./utils/mock-pipeline");
const { parsers: bodyParsers } = require("./utils/body-capture");
const createAdminRouter = require("./utils/admin-router");
const store = require("./store");
const certManager = require("./utils/cert-manager");
const { startProxyServer } = require("./proxy-server");
const requestLog = require("./utils/request-log");
const { createLoggerMiddleware } = requestLog;
const standaloneManager = require("./utils/standalone-manager");
const instanceManager = require("./utils/instance-manager");
const hostRegistry = require("./utils/host-registry");
const mockStats = require("./utils/mock-stats");
const stateStore = require("./utils/state-store");
const accessGate = require("./utils/access-gate");
const sseHub = require("./utils/sse-hub");
const { hostOf } = require("./utils/interception");

const STATE_FILE = path.join(__dirname, "state.json");
const EXAMPLE_STATE_FILE = path.join(__dirname, "state.example.json");
const MOCKS_DIR = path.join(__dirname, "mocks");

// Ensure base directories exist
if (!fs.existsSync(MOCKS_DIR)) fs.mkdirSync(MOCKS_DIR, { recursive: true });

// ── Last-resort process guards ────────────────────────────────────────────────
// This process sits in the path of a whole team's device traffic, so dying takes
// everyone's session with it. These are a net, not a licence to ignore errors:
// anything caught here is a bug and says so loudly.

process.on("unhandledRejection", (reason) => {
  // Always survivable: a rejected promise has not corrupted anything by itself.
  console.error("🔴 [Process] Unhandled promise rejection — continuing:");
  console.error(reason instanceof Error ? reason.stack : reason);
});

// Sockets die in ways that are nobody's fault: a phone walks out of Wi-Fi range,
// a client hangs up mid-body. Those are noise. Anything else has left the process
// in a state no one has reasoned about, so it exits and lets a supervisor restart
// it — see the "Running it" section of README.md.
const SURVIVABLE = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ERR_STREAM_DESTROYED",
]);

process.on("uncaughtException", (err) => {
  if (SURVIVABLE.has(err?.code)) {
    console.error(`🔴 [Process] Ignoring a dead socket (${err.code}): ${err.message}`);
    return;
  }
  console.error("🔴 [Process] Uncaught exception — shutting down:");
  console.error(err?.stack || err);
  process.exit(1);
});

// ── Instances ─────────────────────────────────────────────────────────────────
// The live set of intercepted targets. The proxy re-reads this array on every
// request, so pushing or splicing an entry changes interception with no restart.
// It is filled entirely from state.json — config.js declares no targets any more.
const serverConfigs = [];

// ── State persistence ────────────────────────────────────────────────────────
// The file's layout (one entry per host) is utils/state-store.js's business
// alone; everything here works in the runtime slices it fans out into.

const saveState = () => {
  try {
    // Pulled at write time rather than mirrored on every decision: the gate owns
    // the live set, and a copy kept in the store would go stale the moment
    // anything else triggered a save.
    store.allowedClients = accessGate.remembered();
    stateStore.save(STATE_FILE, { serverConfigs, store });
  } catch (err) {
    console.error("❌ Failed to save server state:", err.message);
  }
};

const readExampleState = () => {
  try {
    return JSON.parse(fs.readFileSync(EXAMPLE_STATE_FILE, "utf8"));
  } catch {
    // Missing or hand-edited into invalid JSON. Only costs the v1 migration its
    // port/name recovery, so carry on rather than refusing to boot.
    return null;
  }
};

const loadState = () => {
  try {
    // state.json is gitignored and config.js no longer carries targets, so a
    // fresh clone would otherwise boot with nothing at all. Seed from the
    // versioned example the first time.
    if (!fs.existsSync(STATE_FILE) && fs.existsSync(EXAMPLE_STATE_FILE)) {
      fs.copyFileSync(EXAMPLE_STATE_FILE, STATE_FILE);
      console.log("🌱 No state.json yet — seeded from state.example.json.");
    }

    const loaded = stateStore.load(STATE_FILE, { seeds: readExampleState() });
    if (!loaded) return;

    serverConfigs.push(...loaded.serverConfigs);
    store.instanceStatus = loaded.instanceStatus;
    store.instanceSettings = loaded.instanceSettings;
    store.hostSettings = loaded.hostSettings;
    store.profiles = loaded.profiles;
    store.standaloneInstances = loaded.standaloneInstances;
    store.allowedClients = loaded.allowedClients;
    accessGate.setRemembered(loaded.allowedClients);

    if (loaded.migrated) {
      console.log(
        "🔁 state.json upgraded to the one-entry-per-host layout.\n" +
          "   The original is kept at state.json.v1.bak."
      );
    }
    console.log(`📂 Server state loaded — ${serverConfigs.length} instance(s).`);
  } catch (err) {
    console.warn("⚠️  Failed to load server state:", err.message);
  }
};

loadState();

// ── Host registry ─────────────────────────────────────────────────────────────
// The registry mirrors the durable per-host prefs onto every record it hands
// out, and folds each decrypted request into that host's counters. Wiring it
// through `onEntry` keeps it out of the middleware chain entirely.
hostRegistry.configure(() => store.hostSettings);
requestLog.onEntry((entry) => hostRegistry.noteRequest(entry));

// "Did my mock fire?" — counted off the same hook, for the same reason: it keeps
// the bookkeeping out of the middleware chain entirely.
requestLog.onEntry((entry) => mockStats.noteEntry(entry));

// ── Access gate ───────────────────────────────────────────────────────────────
// Pending approvals ride the SSE connection the dashboard already holds, on a
// named channel — clients listening only on `onmessage` never see them, so
// nothing else has to change.
accessGate.configure({
  onChange: (event, payload) => sseHub.broadcast(event, payload),
  persist: saveState,
});

// Show the hosts the user has already committed to straight away, rather than
// only once something happens to hit them — otherwise their settings are
// unreachable in the dashboard exactly when you want to set them up.
Object.keys(store.hostSettings).forEach((host) => hostRegistry.ensure(host));

// ── CA certificate ────────────────────────────────────────────────────────────
// Generate (or load) the proxy CA before starting any server so the
// cert-manager is ready when the proxy handles its first CONNECT request.
certManager.ensureCA();

// ── Per-instance state initialisation ─────────────────────────────────────────
// Initialise the state slices for every configured target. This must run whether
// or not the standalone per-instance servers below are started, because the proxy
// and the admin router both read `store.instanceStatus`/`instanceSettings`.
const initInstanceState = ({ id, target }) => {
  if (!store.instanceStatus[id]) store.instanceStatus[id] = {};
  if (!store.instanceSettings[id]) {
    store.instanceSettings[id] = { isActive: true, targetUrl: target, latency: 0 };
  }
  // `latency` (simulated ms per response) postdates early state.json files —
  // normalise so older persisted settings pick up the default.
  if (typeof store.instanceSettings[id].latency !== "number") {
    store.instanceSettings[id].latency = 0;
  }
};

serverConfigs.forEach(initInstanceState);

// ── Optional per-instance Express servers ─────────────────────────────────────
// These listen on each config's dedicated port (:3000/:3001/:3002) and mirror
// what the unified proxy already does for the same targets. They're OFF by
// default to keep the footprint small; enable them only if some flow points
// directly at http://localhost:<port> instead of using the system proxy.

// Every instance now carries a port, so what gates the listener is SSL proxying,
// not the port. That is the honest condition anyway: the pipeline behind this
// port answers with the host's mocks, and while the proxy isn't decrypting the
// host there is nothing for it to be consistent with.
//
// The port check stays as a guard, not a policy: `app.listen(null)` binds a
// *random* port rather than failing, so an entry that somehow lost its port
// would silently open a listener nobody knows the number of.
const isStandaloneEligible = (config) =>
  Number.isInteger(config.port) &&
  store.hostSettings[hostOf(config.target)]?.ssl === true;

const startServer = (config) => {
  const app = express();
  const { id, port, name } = config;

  // Reading the body without changing it, and without ever rejecting one the
  // upstream would have accepted — see utils/body-capture.js.
  bodyParsers().forEach((parser) => app.use(parser));
  // On the standalone servers the Host header reads `localhost:<port>`, so the
  // logger falls back to the instance's configured target for host/protocol.
  app.use(
    createLoggerMiddleware(id, {
      targetUrl: () => store.instanceSettings[id]?.targetUrl,
      trustHostHeader: false,
    })
  );

  // ── Admin routes ────────────────────────────────────────────────────────
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

  // ── Mock interceptor + proxy ────────────────────────────────────────────
  app.use(createBlockMiddleware(store, () => hostOf(config.target)));
  app.use(createMockMiddleware(id, store, MOCKS_DIR));
  app.use("/", createProxyHandler(id, store, MOCKS_DIR));

  const server = app.listen(port, () =>
    console.log(`🚀 [${name}] started: http://localhost:${port}`)
  );
  server.on("error", (e) =>
    console.error(`🔴 [${name}] could not bind :${port} — ${e.message}`)
  );
  return server;
};

// ── Standalone lifecycle (start/stop at runtime) ──────────────────────────────
// Keyed by instance id rather than a flat list, because eligibility now moves
// per host: switching SSL proxying on or off for one host has to start or stop
// exactly that host's listener, without disturbing the others.
const _standaloneServers = new Map(); // instanceId -> http.Server

// Tracked separately from the map: with the tier on and nothing eligible yet,
// "no listeners running" and "switched off" are different states, and only one
// of them should start listening the moment a host gets SSL enabled.
let _standaloneOn = false;

// Set once the proxy is listening; lets the hooks below drop an instance's
// cached app (see the startProxyServer call at the bottom of this file).
let _evictInstanceApp = null;

/** Reconcile the running listeners against what is currently eligible. */
const syncStandalone = () => {
  if (!_standaloneOn) return;

  for (const [id, server] of _standaloneServers) {
    const config = serverConfigs.find((c) => c.id === id);
    if (config && isStandaloneEligible(config)) continue;
    try {
      server.close();
    } catch (_) {
      /* already closed */
    }
    _standaloneServers.delete(id);
  }

  serverConfigs.filter(isStandaloneEligible).forEach((config) => {
    if (_standaloneServers.has(config.id)) return;
    _standaloneServers.set(config.id, startServer(config));
  });
};

const startStandalone = () => {
  _standaloneOn = true;
  syncStandalone();
};

const stopStandalone = () => {
  _standaloneOn = false;
  for (const [id, server] of _standaloneServers) {
    try {
      server.close();
    } catch (_) {
      /* ignore */
    }
    _standaloneServers.delete(id);
  }
  console.log("🟤 Standalone per-instance servers stopped.");
};

// Expose start/stop to the admin router (and thus the dashboard + CLI) without a
// circular dependency.
standaloneManager.configure({
  isEnabled: () => _standaloneOn,
  enable: () => {
    startStandalone();
    store.standaloneInstances = true;
    saveState();
  },
  disable: () => {
    stopStandalone();
    store.standaloneInstances = false;
    saveState();
  },
  // Called by the router after anything that can change eligibility — chiefly
  // toggling SSL proxying, which is what decides whether a host's listener
  // should be up at all.
  sync: syncStandalone,
});

// ── Dynamic instances (add/remove intercepted targets at runtime) ─────────────
// The proxy resolves targets by reading the shared serverConfigs array live on
// every request, so pushing a new entry makes it intercept the host immediately
// — no restart. cert-manager mints per-host certs on demand. The core logic
// lives in instance-manager; we inject the side effects (state seeding,
// persistence, and keeping the optional standalone servers in sync).
instanceManager.configure(
  instanceManager.createImpl({
    serverConfigs,
    store,
    initInstanceState,
    persist: saveState,
    onAdded: (inst) => {
      // Not started here: the caller enables SSL proxying *after* this returns,
      // and that flag is what makes a host eligible. `syncStandalone` runs from
      // the SSL route instead, which is the moment eligibility actually changes.
      console.log(`➕ [Instance] Added "${inst.id}" → ${inst.target}.`);
    },
    onRemoved: (inst) => {
      syncStandalone();
      // Drop the proxy's cached Express app + http.Server for this instance.
      // Nothing routes to it once it leaves serverConfigs, so without this it
      // just sits in memory for the life of the process.
      _evictInstanceApp?.(inst.id);
      console.log(`➖ [Instance] Removed "${inst.id}".`);
    },
    onRenamed: (inst, oldId) => {
      // The cached app closes over the instance id — the logging middleware and
      // the mock pipeline both captured it — so a surviving one would keep
      // writing the old id into the activity log. Evicting forces a rebuild.
      _evictInstanceApp?.(oldId);
      // Same reason on the standalone side: the listener was built for oldId.
      syncStandalone();
      console.log(`✏️  [Instance] Renamed "${oldId}" → "${inst.id}".`);
    },
  })
);

// Honour the boot-time preference: env flag, config, or the persisted choice.
const standaloneAtBoot =
  process.env.STANDALONE_INSTANCES === "1" ||
  proxyConfig?.standaloneInstances === true ||
  store.standaloneInstances === true;

// ── Unified proxy server ──────────────────────────────────────────────────────

// The proxy goes first, and the standalone tier only starts once it is up. That
// ordering is what makes the "already running" abort readable: bind :3000…:3007
// first and a duplicate boot buries its own explanation under eight EADDRINUSE
// lines from ports the live instance already owns.
startProxyServer({
  serverConfigs,
  store,
  MOCKS_DIR,
  STATE_FILE,
  saveState,
  preferredPort: proxyConfig?.preferredPort ?? 8888,
})
  .then((proxy) => {
    // The instance manager is configured before the proxy exists, so it holds
    // the evictor through this late-bound reference rather than by argument.
    _evictInstanceApp = proxy.evictInstanceApp;

    if (standaloneAtBoot) {
      startStandalone();
      store.standaloneInstances = true;
      console.log("🟢 Standalone per-instance servers enabled.");
    } else {
      console.log(
        "⚪ Standalone per-instance servers disabled — unified proxy only.\n" +
          "   Enable from the dashboard, `npm run mock -- standalone --on`, or STANDALONE_INSTANCES=1."
      );
    }
  })
  .catch((err) => {
    if (err.code === "EPROXYRUNNING") {
      // Not an error the user needs a stack trace for — they ran `npm start`
      // twice. Say where the live one is and stop, rather than becoming a second
      // copy that fights the first over state.json.
      console.error(
        `\n❌ ${err.message}\n` +
          `   Open http://localhost:${err.port} — that instance is already serving\n` +
          `   the dashboard, the mocks and the admin API.\n\n` +
          `   To stop it:      kill $(lsof -ti :${err.port})\n` +
          `   To run anyway:   ALLOW_MULTIPLE_INSTANCES=1 npm start\n` +
          `                    (both would share state.json and overwrite each other)\n`
      );
      process.exit(1);
    }
    console.error("❌ Failed to start proxy server:", err.message);
  });
