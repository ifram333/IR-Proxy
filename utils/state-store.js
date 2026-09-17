/**
 * state-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The only module that knows what state.json looks like on disk.
 *
 * At runtime a host's facts live in four separate slices, keyed two different
 * ways: `hostSettings` by hostname, and `instanceStatus`/`instanceSettings`/
 * `serverConfigs` by instance id. That shape suits the code — every consumer
 * reads exactly the slice it needs — and is miserable to read, because
 * understanding one host means cross-referencing four sections by hand.
 *
 * The file therefore uses the other shape: one entry per host, everything about
 * it in one place. `load` fans that out into the slices, `save` folds them back,
 * and nothing else in the codebase sees the file's layout — which is why
 * changing it touched no consumers.
 *
 * The two URLs are named apart here because they are not the same thing:
 *   • `host`     — what gets intercepted. `resolveInstanceForHost` matches on it.
 *   • `upstream` — where unmocked requests are forwarded. Free to point
 *                  somewhere else entirely, which is how you intercept prod and
 *                  answer from QA.
 */

"use strict";

const fs = require("fs");
const { hostOf } = require("./interception");
const { normalizeBlockPath } = require("./blocking");

const CURRENT_VERSION = 2;

/** Where a promoted host's standalone port allocation starts. */
const FIRST_PORT = 3000;

/** Matches what Prettier does to state.example.json, so the two files look alike. */
const INDENT = 2;

/**
 * Omitted when writing, assumed when reading. Not having `"latency": 0` and
 * `"isActive": true` on every single entry is most of what makes the file
 * scannable.
 */
const DEFAULTS = Object.freeze({
  ssl: false,
  focus: "none",
  isActive: true,
  latency: 0,
  protocol: "https",
});

/** Build the intercepted-target URL the runtime matches hosts against. */
function targetOf(entry) {
  const protocol = entry.protocol === "http" ? "http" : "https";
  return `${protocol}://${entry.host}`;
}

/**
 * Key order for a written entry: what it is, then where it points, then how it
 * behaves, then the long tail of mock toggles.
 *
 * JSON.stringify emits keys in insertion order, and the two builders below fill
 * entries in whatever order they happen to visit the runtime slices. Left alone
 * that puts `ssl` above `id` in one and below it in the other — readable enough
 * in isolation, inconsistent across a file you are scanning.
 */
const KEY_ORDER = [
  "id",
  "name",
  "host",
  "protocol",
  "upstream",
  "port",
  "ssl",
  "focus",
  "isActive",
  "latency",
  "blocks",
  "mocks",
];

function ordered(entry) {
  const out = {};
  KEY_ORDER.forEach((key) => {
    if (entry[key] !== undefined) out[key] = entry[key];
  });
  return out;
}

/** Instances first, then the hosts we merely have an opinion about. */
function byIdThenHost(a, b) {
  if (Boolean(a.id) !== Boolean(b.id)) return a.id ? -1 : 1;
  return (a.id || a.host).localeCompare(b.id || b.host);
}

// ── Disk → runtime ───────────────────────────────────────────────────────────

/**
 * Fan one entry out over the runtime slices.
 *
 * An entry carries an `id` if and only if it is an instance. Entries without one
 * exist purely to remember a `focus` — the "ignore this CDN" case — and so
 * produce a host-settings row and nothing else.
 */
function applyEntry(entry, runtime) {
  if (!entry || typeof entry.host !== "string" || !entry.host) return;
  const host = entry.host;

  runtime.hostSettings[host] = {
    ssl: entry.ssl === true,
    focus: entry.focus || DEFAULTS.focus,
    instanceId: entry.id || null,
    // Normalised on the way in, so a hand-edited file can't leave a rule that
    // looks like it blocks something and doesn't.
    blocks: Array.isArray(entry.blocks)
      ? entry.blocks.map(normalizeBlockPath).filter(Boolean)
      : [],
  };

  if (!entry.id) return;

  const target = targetOf(entry);
  runtime.serverConfigs.push({
    id: entry.id,
    port: Number.isInteger(entry.port) ? entry.port : null,
    target,
    name: entry.name || host,
  });
  runtime.instanceSettings[entry.id] = {
    isActive: entry.isActive !== false,
    targetUrl: entry.upstream || target,
    latency: Number.isInteger(entry.latency) ? entry.latency : DEFAULTS.latency,
  };
  runtime.instanceStatus[entry.id] = { ...(entry.mocks || {}) };
}

/** Turn a v2 document into the slices `store` and `serverConfigs` expect. */
function toRuntime(doc) {
  const runtime = {
    serverConfigs: [],
    instanceStatus: {},
    instanceSettings: {},
    hostSettings: {},
    profiles: (doc && doc.profiles) || {},
    standaloneInstances: Boolean(doc && doc.proxy && doc.proxy.standalone),
    // Machines the operator chose to remember when approving their access.
    allowedClients: Array.isArray(doc?.proxy?.allowedClients)
      ? doc.proxy.allowedClients
      : [],
  };
  const entries = doc && Array.isArray(doc.instances) ? doc.instances : [];
  entries.forEach((entry) => applyEntry(entry, runtime));
  return runtime;
}

// ── Runtime → disk ───────────────────────────────────────────────────────────

/**
 * Fold the runtime slices back into one entry per host.
 *
 * Only entries worth keeping are written: an instance always is, and a bare host
 * is only when its settings differ from the defaults. Without that filter, a dev
 * browsing through the proxy would grow state.json by every CDN and analytics
 * host they touched.
 */
function fromRuntime({ serverConfigs = [], store = {} } = {}) {
  const byHost = new Map();
  const entryFor = (host) => {
    if (!byHost.has(host)) byHost.set(host, { host });
    return byHost.get(host);
  };

  // Instances first — they carry the identity (id, port, name) that the
  // host-settings rows below only reference.
  serverConfigs.forEach((cfg) => {
    const host = hostOf(cfg && cfg.target);
    if (!host) return;
    const settings = (store.instanceSettings || {})[cfg.id] || {};
    const mocks = (store.instanceStatus || {})[cfg.id] || {};
    const entry = entryFor(host);

    entry.id = cfg.id;
    entry.name = cfg.name || host;
    if (String(cfg.target).startsWith("http://")) entry.protocol = "http";
    // Always written, unlike the other optional fields: where a host forwards to
    // is the fact you most want to see, and inferring it from `host` is exactly
    // the cross-referencing this format exists to avoid.
    entry.upstream = settings.targetUrl || targetOf(entry);
    if (Number.isInteger(cfg.port)) entry.port = cfg.port;
    if (settings.isActive === false) entry.isActive = false;
    if (settings.latency) entry.latency = settings.latency;
    if (Object.keys(mocks).length) entry.mocks = { ...mocks };
  });

  Object.entries(store.hostSettings || {}).forEach(([host, settings]) => {
    if (!settings) return;
    const ssl = settings.ssl === true;
    const focus = settings.focus || DEFAULTS.focus;
    const blocks = Array.isArray(settings.blocks) ? settings.blocks : [];
    const known = byHost.has(host);
    // A row nobody has an opinion about is not worth a line in the file — and a
    // block rule is very much an opinion, so it keeps the row alive on its own.
    if (!known && !ssl && focus === DEFAULTS.focus && !blocks.length) return;
    const entry = entryFor(host);
    if (ssl) entry.ssl = true;
    if (focus !== DEFAULTS.focus) entry.focus = focus;
    if (blocks.length) entry.blocks = [...blocks].sort();
  });

  // Deterministic: a file people read and diff shouldn't reshuffle every save.
  const entries = [...byHost.values()].sort(byIdThenHost).map(ordered);

  const proxy = { standalone: store.standaloneInstances === true };
  // Omitted when empty, like every other default — an approval list nobody has
  // used shouldn't be a line in the file.
  const allowed = Array.isArray(store.allowedClients) ? store.allowedClients : [];
  if (allowed.length) proxy.allowedClients = [...allowed].sort();

  return {
    version: CURRENT_VERSION,
    proxy,
    instances: entries,
    profiles: store.profiles || {},
  };
}

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * Convert the pre-v2 layout (four id/host-keyed maps plus `dynamicInstances`)
 * into v2.
 *
 * `seeds` matters when there are any: in v1 the static targets lived in
 * config.js, not in state.json, so their `port` and `name` are simply absent
 * from the file being migrated, and state.example.json is the successor of that
 * config block. A checkout that has put its own entries there gets those two
 * fields back; the shipped seed is **empty**, so out of the box a migrated
 * instance falls back to its hostname for a name and a freshly allocated port.
 * That is the honest outcome — the alternative is inventing a name — and it
 * only touches a state.json written before v2.
 *
 * @param {object} doc   the parsed v1 state.json
 * @param {object} [seeds] the parsed state.example.json
 */
function migrateV1(doc = {}, seeds = null) {
  const seedById = new Map();
  if (seeds && Array.isArray(seeds.instances)) {
    seeds.instances.forEach((entry) => {
      if (entry && entry.id) seedById.set(entry.id, entry);
    });
  }

  const dynamicById = new Map();
  (Array.isArray(doc.dynamicInstances) ? doc.dynamicInstances : []).forEach((inst) => {
    if (inst && inst.id) dynamicById.set(inst.id, inst);
  });

  const hostSettings = doc.hostSettings || {};
  const instanceSettings = doc.instanceSettings || {};
  const instanceStatus = doc.instanceStatus || {};

  // hostSettings is what maps an id back to a hostname; without a row here an
  // instance has no host to be keyed by, so orphaned settings slices are
  // dropped rather than resurrected under a guessed name.
  const hostForInstance = new Map();
  Object.entries(hostSettings).forEach(([host, settings]) => {
    if (settings && settings.instanceId) hostForInstance.set(settings.instanceId, host);
  });

  const usedPorts = new Set();
  [...dynamicById.values(), ...seedById.values()].forEach((inst) => {
    if (Number.isInteger(inst.port)) usedPorts.add(inst.port);
  });
  const nextPort = () => {
    let port = FIRST_PORT;
    while (usedPorts.has(port)) port++;
    usedPorts.add(port);
    return port;
  };

  const byHost = new Map();
  const entryFor = (host) => {
    if (!byHost.has(host)) byHost.set(host, { host });
    return byHost.get(host);
  };

  Object.entries(hostSettings).forEach(([host, settings]) => {
    const entry = entryFor(host);
    if (settings && settings.ssl === true) entry.ssl = true;
    if (settings && settings.focus && settings.focus !== DEFAULTS.focus) {
      entry.focus = settings.focus;
    }
  });

  Object.keys(instanceSettings).forEach((id) => {
    const host = hostForInstance.get(id) || hostOf(instanceSettings[id]?.targetUrl);
    if (!host) return;
    const legacy = dynamicById.get(id) || seedById.get(id) || {};
    const settings = instanceSettings[id] || {};
    const mocks = instanceStatus[id] || {};
    const entry = entryFor(host);

    entry.id = id;
    entry.name = legacy.name || host;
    if (String(legacy.target || "").startsWith("http://")) entry.protocol = "http";
    entry.upstream = settings.targetUrl || targetOf(entry);
    // Every instance gets a port now, including the ones v1 promoted with
    // `port: null`, so the standalone tier can serve them too.
    entry.port = Number.isInteger(legacy.port) ? legacy.port : nextPort();
    if (settings.isActive === false) entry.isActive = false;
    if (settings.latency) entry.latency = settings.latency;
    if (Object.keys(mocks).length) entry.mocks = { ...mocks };
  });

  const entries = [...byHost.values()]
    .filter((entry) => entry.id || entry.ssl || entry.focus)
    .sort(byIdThenHost)
    .map(ordered);

  return {
    version: CURRENT_VERSION,
    proxy: { standalone: doc.standaloneInstances === true },
    instances: entries,
    profiles: doc.profiles || {},
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read state from disk, migrating it in place if it predates v2.
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {object} [opts.seeds] parsed state.example.json, for the v1 migration
 * @returns {object|null} the runtime slices plus `migrated`, or null when the
 *                        file does not exist
 */
function load(file, { seeds = null } = {}) {
  if (!file || !fs.existsSync(file)) return null;

  const raw = fs.readFileSync(file, "utf8");
  const doc = JSON.parse(raw);

  if (doc && doc.version === CURRENT_VERSION) {
    return { ...toRuntime(doc), migrated: false };
  }

  const migrated = migrateV1(doc, seeds);
  // Keep the original next to the new one. This runs once, unattended, over
  // months of accumulated mock toggles — a bad conversion has to be recoverable
  // by hand rather than only by remembering to have made a copy.
  fs.writeFileSync(`${file}.v1.bak`, raw, "utf8");
  fs.writeFileSync(file, JSON.stringify(migrated, null, INDENT), "utf8");

  return { ...toRuntime(migrated), migrated: true };
}

/**
 * Write the runtime slices back out in v2 layout.
 * @param {string} file
 * @param {{serverConfigs: Array, store: object}} runtime
 */
function save(file, runtime) {
  fs.writeFileSync(file, JSON.stringify(fromRuntime(runtime), null, INDENT), "utf8");
}

module.exports = {
  CURRENT_VERSION,
  FIRST_PORT,
  DEFAULTS,
  load,
  save,
  toRuntime,
  fromRuntime,
  migrateV1,
};
