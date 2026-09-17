/**
 * Instances: settings, add, remove, rename — plus the standalone listener tier,
 * which is the per-instance side of the proxy and lives or dies with them.
 *
 * Renaming is the delicate one. Mock files scope themselves to an instance id by
 * hand (`servers: ["api"]`), so every rewrite is computed and validated in memory
 * before anything is written: a file that can't be transformed aborts the rename
 * before the runtime has been touched.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const fs = require("fs");
const loadMocks = require("../mock-loader");
const requestLog = require("../request-log");
const captureSessions = require("../capture-sessions");
const { setMockServers } = require("../mock-scope");
const standaloneManager = require("../standalone-manager");
const instanceManager = require("../instance-manager");
const mockStats = require("../mock-stats");
const requestStore = require("../request-store");
const { hostOf } = require("../interception");

module.exports = function registerInstances(router, ctx) {
  const {
    MOCKS_DIR,
    store,
    serverConfigs,
    saveState,
    safePath,
    requireJsonBody,
    updateHostSettings,
  } = ctx;

  const httpError = (status, message) => {
    const err = new Error(message);
    err.status = status;
    return err;
  };

  /**
   * Work out which `.mock.js` files a rename has to rewrite, and what they
   * should say afterwards — without touching disk.
   *
   * Returned rather than applied so the caller can validate everything before
   * committing to any of it: `setMockServers` throws when it can't locate the
   * mock in its file, and finding that out halfway through a rename leaves the
   * repo in a state nobody asked for.
   *
   * Grouped by file because one file can hold several mocks, and each rewrite
   * has to be applied on top of the previous one rather than to the original.
   */
  const planScopeRewrites = (oldId, requested) => {
    if (typeof requested !== "string") throw httpError(400, "id must be a string");
    const newId = instanceManager.slugify(requested);
    if (!newId) throw httpError(400, "id must contain at least one letter or digit");
    if (newId === oldId) return [];

    const affected = loadMocks(MOCKS_DIR).filter(
      (m) => Array.isArray(m.servers) && m.servers.includes(oldId)
    );

    const byFile = new Map();
    try {
      affected.forEach((mock) => {
        const filePath = safePath(mock.file);
        if (!byFile.has(filePath))
          byFile.set(filePath, fs.readFileSync(filePath, "utf8"));
        const servers = mock.servers.map((id) => (id === oldId ? newId : id));
        byFile.set(filePath, setMockServers(byFile.get(filePath), mock.name, servers));
      });
    } catch (err) {
      throw httpError(500, `Could not rescope mocks: ${err.message}`);
    }

    return [...byFile.entries()].map(([filePath, source]) => ({ filePath, source }));
  };

  router.post("/instance-settings", (req, res) => {
    const { instanceId: id, isActive, targetUrl, latency, name } = req.body;
    if (!id) return res.status(400).json({ error: "instanceId is required" });
    if (!store.instanceSettings[id])
      return res.status(404).json({ error: `Instance "${id}" not found` });

    // `name` lives on the serverConfig, not the settings slice, so it goes
    // through the instance manager — which owns that array and its validation.
    // Applied first: if the label is rejected, nothing else should have landed.
    if (name !== undefined) {
      try {
        instanceManager.setInstanceName(id, name);
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    if (latency !== undefined) {
      const ms = Number(latency);
      if (!Number.isInteger(ms) || ms < 0 || ms > 120000) {
        return res
          .status(400)
          .json({ error: "latency must be an integer between 0 and 120000 (ms)" });
      }
      store.instanceSettings[id].latency = ms;
    }
    if (isActive !== undefined) store.instanceSettings[id].isActive = isActive;
    if (targetUrl !== undefined) {
      // Validated here rather than on use: this string becomes the `router` of
      // http-proxy-middleware (mock-pipeline.js), so a malformed value doesn't
      // fail now — it fails on the next unmocked request, far from the edit that
      // caused it.
      let url;
      try {
        url = new URL(targetUrl);
      } catch {
        return res
          .status(400)
          .json({ error: "targetUrl must be a valid URL, e.g. https://api.example.com" });
      }
      if (!/^https?:$/.test(url.protocol)) {
        return res.status(400).json({ error: "targetUrl must be http(s)" });
      }
      store.instanceSettings[id].targetUrl = url.origin;
    }
    saveState();
    res.json({
      ok: true,
      instanceId: id,
      settings: store.instanceSettings[id],
      // Echoed back because the server trims it — the caller needs to know what
      // was actually stored, not what it sent.
      name: serverConfigs.find((c) => c.id === id)?.name,
    });
  });

  // ── Dynamic instances (add/remove intercepted targets at runtime) ─────────
  router.post("/instances", (req, res) => {
    if (!requireJsonBody(req, res)) return;
    try {
      const instance = instanceManager.addInstance({
        target: req.body.target,
        name: req.body.name,
      });
      // Typing a target in by hand means "I want to intercept this", so turn
      // SSL proxying on rather than adding a host that does nothing until it's
      // enabled from a second, non-obvious place.
      const host = hostOf(instance.target);
      if (host) updateHostSettings(host, { ssl: true, instanceId: instance.id });
      res.status(201).json({ ok: true, instance });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.delete("/instances/:id", (req, res) => {
    try {
      const removed = instanceManager.removeInstance(req.params.id);
      standaloneManager.sync();
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  /**
   * Rename an instance.
   *
   * The id is not just a label: mock files scope themselves to it by hand
   * (`servers: ["api"]`), so renaming without rewriting them detaches those
   * mocks silently — they stay enabled, match nothing, and nothing says why.
   *
   * Order matters. Every rewrite is computed and validated in memory first, then
   * the runtime is re-keyed, then the files are flushed. A file that can't be
   * transformed aborts the whole thing before anything has changed.
   */
  router.post("/instances/:id/rename", (req, res) => {
    const oldId = req.params.id;
    const { id: requested } = req.body || {};

    let rewrites;
    try {
      rewrites = planScopeRewrites(oldId, requested);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    let instance;
    try {
      instance = instanceManager.renameInstance(oldId, requested);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    // A no-op rename (the slug matched what it already was) planned no rewrites.
    rewrites.forEach(({ filePath, source }) =>
      fs.writeFileSync(filePath, source, "utf8")
    );
    if (rewrites.length) loadMocks.invalidate();

    // The activity log and any open capture session are keyed by instance id
    // too; without this their existing rows point at an id that no longer
    // exists, and the tree's per-host "Clear log" stops matching them.
    requestLog.renameInstance(oldId, instance.id);
    captureSessions.renameInstance(oldId, instance.id);
    mockStats.renameInstance(oldId, instance.id);
    // Saved requests are scoped by instance id the same way mock files are, so
    // a rename that skipped them would leave them listed but unsendable.
    const resaved = requestStore.renameInstance(oldId, instance.id);

    console.log(
      `✏️  [ADMIN] Renamed instance "${oldId}" → "${instance.id}"` +
        (rewrites.length ? ` (${rewrites.length} mock file(s) rescoped)` : "") +
        (resaved ? ` (${resaved} saved request(s) repointed)` : "")
    );
    res.json({
      ok: true,
      id: instance.id,
      instance,
      rescoped: rewrites.length,
      resaved,
    });
  });

  // ── Standalone per-instance servers (:3000/:3001/:3002) ───────────────────
  router.get("/standalone", (_req, res) => {
    res.json({ enabled: standaloneManager.isEnabled() });
  });

  router.post("/standalone", (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Required field: enabled (boolean)" });
    }
    try {
      if (enabled) standaloneManager.enable();
      else standaloneManager.disable();
      console.log(`🔌 [ADMIN] Standalone instances → ${enabled ? "ON" : "OFF"}`);
      res.json({ ok: true, enabled: standaloneManager.isEnabled() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
