/**
 * instance-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lets the admin router (and thus the dashboard/CLI) add and remove intercepted
 * instances at runtime.
 *
 * `createImpl()` holds the portable core logic (validation, id/port allocation,
 * mutating the shared serverConfigs array + store, persistence). The host
 * process (server.js) injects its side-effect hooks and registers the result via
 * `configure()`; the router then calls through the thin `addInstance` /
 * `removeInstance` facade. This keeps the dependency one-directional
 * (server.js → router) and avoids a circular require — mirroring
 * standalone-manager.js — while staying unit-testable.
 */

"use strict";

let _impl = null; // { addInstance(spec), removeInstance(id) }

/** Wire up the real implementation (called once from server.js). */
function configure(impl) {
  _impl = impl;
}

/**
 * Register a new intercepted instance. `spec` is `{ target, name }`; the id and
 * an incremental port are assigned here. Returns the created instance. Throws an
 * Error carrying a `.status` on bad input.
 */
function addInstance(spec) {
  if (!_impl) throw new Error("Instance manager is not configured");
  return _impl.addInstance(spec);
}

/** Remove an instance by id, along with every slice keyed by it. */
function removeInstance(id) {
  if (!_impl) throw new Error("Instance manager is not configured");
  return _impl.removeInstance(id);
}

/**
 * Change an instance's id, re-keying every store slice that referenced it.
 * Returns the instance with its (slugified) new id.
 *
 * Does NOT touch the `servers: [...]` scopes inside `.mock.js` files — that is
 * disk work, and the caller owns it. See the rename endpoint in admin-router.js.
 */
function renameInstance(oldId, newId) {
  if (!_impl) throw new Error("Instance manager is not configured");
  return _impl.renameInstance(oldId, newId);
}

/** Change an instance's display name. Purely a label; nothing keys off it. */
function setInstanceName(id, name) {
  if (!_impl) throw new Error("Instance manager is not configured");
  return _impl.setInstanceName(id, name);
}

/**
 * Get the instance that serves `host`, creating one if there isn't one yet.
 *
 * This is the "promote a discovered host" path: enabling SSL proxying on a host
 * needs a mock pipeline behind it, and in this codebase a pipeline *is* an
 * instance (everything downstream is keyed by instanceId). Unlike `addInstance`
 * this is idempotent — it returns the existing config rather than rejecting a
 * duplicate — because "make sure this host is intercepted" is a different
 * question from "add a new target I just typed in".
 */
function ensureInstanceForHost(host, protocol) {
  if (!_impl) throw new Error("Instance manager is not configured");
  return _impl.ensureInstanceForHost(host, protocol);
}

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

const fail = (status, message) => {
  const err = new Error(message);
  err.status = status;
  throw err;
};

const hostOf = (target) => {
  try {
    return new URL(target).hostname;
  } catch {
    return null;
  }
};

/** Where the standalone tier's per-instance ports start. */
const FIRST_PORT = 3000;

/**
 * Lowest free port at or above FIRST_PORT.
 *
 * Deliberately not `max + 1`: hosts get promoted and dropped all day now that
 * enabling SSL allocates one, and a high-water mark would climb away from the
 * range the developer has firewall holes and bookmarks for, while never reusing
 * the gaps it left behind.
 */
function allocatePort(serverConfigs) {
  const taken = new Set(serverConfigs.map((c) => c.port).filter(Number.isInteger));
  let port = FIRST_PORT;
  while (taken.has(port)) port++;
  return port;
}

/** Move a map entry from one key to another, leaving nothing behind. */
function rekey(map, oldKey, newKey) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, oldKey)) return;
  map[newKey] = map[oldKey];
  delete map[oldKey];
}

// `name` is client-supplied and is rendered in the dashboard. The frontend
// HTML-escapes it, but reject the HTML metacharacters (<, >, &, ", ', backtick)
// and control characters server-side too (defence-in-depth). Spaces and
// ordinary punctuation stay allowed, e.g. "Example API".
// eslint-disable-next-line no-control-regex -- control chars are rejected on purpose
const UNSAFE_NAME = /[<>&"'\x60\x00-\x1f]/;

/**
 * Shared by `addInstance`, `setInstanceName` and the profile routes, so every
 * client-supplied label that ends up rendered in the dashboard is held to the
 * same standard. Throws an Error carrying `.status`.
 */
function validateName(name) {
  if (typeof name !== "string") fail(400, "name must be a string");
  const trimmed = name.trim();
  if (!trimmed) fail(400, "name can't be empty");
  if (trimmed.length > 64) fail(400, "name must be 64 characters or fewer");
  if (UNSAFE_NAME.test(trimmed)) fail(400, "name contains invalid characters");
  return trimmed;
}

/**
 * Build the add/remove implementation around the shared `serverConfigs` array
 * and `store`. The host injects side-effect hooks:
 *   initInstanceState(inst) — seed the per-instance store slices
 *   persist()               — write state to disk (saveState)
 *   onAdded(inst)           — optional, e.g. start a standalone server
 *   onRemoved(inst)         — optional, e.g. bounce the standalone servers
 *   onRenamed(inst, oldId)  — optional, e.g. evict the cached app for the old id
 *
 * The proxy resolves targets by reading `serverConfigs` live on every request,
 * so pushing/splicing here changes interception immediately, with no restart.
 */
function createImpl({
  serverConfigs,
  store,
  initInstanceState,
  persist,
  onAdded,
  onRemoved,
  onRenamed,
} = {}) {
  return {
    addInstance({ target, name } = {}) {
      if (!target || typeof target !== "string") fail(400, "target is required");
      let url;
      try {
        url = new URL(target);
      } catch {
        fail(400, "target must be a valid URL, e.g. https://api.example.com");
      }
      if (!/^https?:$/.test(url.protocol)) fail(400, "target must be http(s)");

      if (name != null) name = validateName(name);

      const host = url.hostname;
      if (serverConfigs.some((c) => hostOf(c.target) === host)) {
        fail(409, `Host "${host}" is already being intercepted`);
      }

      const base = slugify(name) || slugify(host) || "instance";
      let id = base;
      for (let n = 2; serverConfigs.some((c) => c.id === id); n++) {
        id = `${base}-${n}`;
      }

      const instance = {
        id,
        port: allocatePort(serverConfigs),
        target: url.origin,
        name: name || host,
      };
      serverConfigs.push(instance);
      if (initInstanceState) initInstanceState(instance);
      if (onAdded) onAdded(instance);
      if (persist) persist();
      return instance;
    },

    ensureInstanceForHost(host, protocol = "https") {
      if (!host || typeof host !== "string") fail(400, "host is required");

      const existing = serverConfigs.find((c) => hostOf(c.target) === host);
      if (existing) return existing;

      // This name is taken straight from the wire and ends up rendered in the
      // dashboard, so it gets the same screening `addInstance` gives a
      // user-typed name. `new URL` alone lets quotes and `=` through.
      if (host.length > 253 || UNSAFE_NAME.test(host)) {
        fail(400, "host contains invalid characters");
      }

      const scheme = protocol === "http" ? "http" : "https";
      let url;
      try {
        url = new URL(`${scheme}://${host}`);
      } catch {
        fail(400, "that is not a valid hostname");
      }

      const base = slugify(host) || "instance";
      let id = base;
      for (let n = 2; serverConfigs.some((c) => c.id === id); n++) {
        id = `${base}-${n}`;
      }

      // A promoted host gets a port like any other instance. That used to be
      // `null` to stop the standalone tier binding one listener per browsed
      // host, but promotion only happens when SSL proxying is switched on, and
      // the tier now gates on that flag rather than on the port — so the set is
      // bounded by what the user deliberately enabled.
      const instance = {
        id,
        port: allocatePort(serverConfigs),
        target: url.origin,
        name: host,
      };
      serverConfigs.push(instance);
      if (initInstanceState) initInstanceState(instance);
      if (onAdded) onAdded(instance);
      if (persist) persist();
      return instance;
    },

    /**
     * Drop an instance and everything keyed by it.
     *
     * Every instance is removable now that config.js declares none — there is no
     * longer a static tier to protect. The host's own settings row goes too:
     * leaving `hostSettings[host].instanceId` pointing at a deleted instance is
     * what used to leave a host half-erased across state.json.
     */
    removeInstance(id) {
      const idx = serverConfigs.findIndex((c) => c.id === id);
      if (idx === -1) fail(404, `Instance "${id}" not found`);
      const instance = serverConfigs[idx];

      serverConfigs.splice(idx, 1);
      delete store.instanceStatus[id];
      delete store.instanceSettings[id];

      const host = hostOf(instance.target);
      if (host) delete store.hostSettings[host];
      // Any other host pointed at this instance would keep a switch that can
      // never decrypt anything (shouldMitm needs a live instance).
      Object.values(store.hostSettings || {}).forEach((entry) => {
        if (entry && entry.instanceId === id) {
          entry.instanceId = null;
          entry.ssl = false;
        }
      });

      if (onRemoved) onRemoved(instance);
      if (persist) persist();
      return id;
    },

    /**
     * Change an instance's display name.
     *
     * Only a label — unlike the id, nothing keys off it, so there is nothing to
     * re-key and no mock file to rewrite. It does get rendered in the dashboard
     * though, which is why it goes through the same screening as a name typed
     * into the add-instance box.
     */
    setInstanceName(id, name) {
      const instance = serverConfigs.find((c) => c.id === id);
      if (!instance) fail(404, `Instance "${id}" not found`);
      instance.name = validateName(name);
      if (persist) persist();
      return instance;
    },

    renameInstance(oldId, newId) {
      const instance = serverConfigs.find((c) => c.id === oldId);
      if (!instance) fail(404, `Instance "${oldId}" not found`);
      if (typeof newId !== "string") fail(400, "id must be a string");

      // Slugified rather than rejected, matching how ids are minted in
      // `addInstance`. The caller gets the final id back so the UI can show what
      // the typed value actually became.
      const id = slugify(newId);
      if (!id) fail(400, "id must contain at least one letter or digit");
      if (id === oldId) return instance;
      if (serverConfigs.some((c) => c.id === id)) {
        fail(409, `Instance "${id}" already exists`);
      }

      instance.id = id;
      // Both slices are keyed by instance id; missing one leaves an orphan that
      // nothing reads and nothing ever cleans up.
      rekey(store.instanceStatus, oldId, id);
      rekey(store.instanceSettings, oldId, id);
      Object.values(store.hostSettings || {}).forEach((entry) => {
        if (entry && entry.instanceId === oldId) entry.instanceId = id;
      });

      if (onRenamed) onRenamed(instance, oldId);
      if (persist) persist();
      return instance;
    },
  };
}

module.exports = {
  configure,
  addInstance,
  removeInstance,
  renameInstance,
  setInstanceName,
  ensureInstanceForHost,
  allocatePort,
  createImpl,
  validateName,
  // Exported so callers can compute the id a rename will actually produce
  // *before* committing to it — the mock-file rewrites have to target the same
  // slug this module will assign, or they scope themselves to an id that never
  // comes into existence.
  slugify,
  FIRST_PORT,
};
