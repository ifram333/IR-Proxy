/**
 * The host registry: every host the connected devices reached for.
 *
 * `/hosts/ssl` is the switch the whole proxy turns on. Enabling promotes the host
 * to an instance so there is a mock pipeline behind it; disabling only clears the
 * flag, because removing the instance would take every mock toggle with it.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const requestLog = require("../request-log");
const hostRegistry = require("../host-registry");
const standaloneManager = require("../standalone-manager");
const instanceManager = require("../instance-manager");
const mockStats = require("../mock-stats");
const blocking = require("../blocking");

module.exports = function registerHosts(router, ctx) {
  const { store, serverConfigs, saveState, updateHostSettings } = ctx;

  // ── Host registry ──────────────────────────────────────────────────────────
  // Every host the connected devices reached for, decrypted or merely tunneled.

  router.get("/hosts", (_req, res) => {
    res.json({ hosts: hostRegistry.list() });
  });

  /**
   * Turn SSL proxying on or off for a host.
   *
   * Enabling promotes the host to an instance so it has a mock pipeline behind
   * it. Disabling only clears the flag — it deliberately does NOT remove the
   * instance, because that would delete every mock toggle for the host along
   * with it. Takes effect on the next connection; tunnels already open keep the
   * mode they were established with.
   */
  router.post("/hosts/ssl", (req, res) => {
    const { host, enabled } = req.body || {};
    if (!host || typeof host !== "string") {
      return res.status(400).json({ error: "host is required" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    if (!enabled) {
      const settings = updateHostSettings(host, { ssl: false });
      // The instance keeps its port so it comes back on the same one; what stops
      // is the listener.
      standaloneManager.sync();
      return res.json({ ok: true, host, ssl: false, instanceId: settings.instanceId });
    }

    try {
      const record = hostRegistry.get(host);
      const protocol = record?.protocols?.includes("https")
        ? "https"
        : record?.protocols?.[0] || "https";
      const instance = instanceManager.ensureInstanceForHost(host, protocol);
      const settings = updateHostSettings(host, {
        ssl: true,
        instanceId: instance.id,
      });
      // Only now is the host eligible for a standalone listener — the instance
      // exists and the SSL flag that gates it is set.
      standaloneManager.sync();
      res.json({ ok: true, host, ssl: true, instanceId: settings.instanceId, instance });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /** Move a host between the tree's Focused / normal / Ignored sections. */
  router.post("/hosts/focus", (req, res) => {
    const { host, focus } = req.body || {};
    if (!host || typeof host !== "string") {
      return res.status(400).json({ error: "host is required" });
    }
    if (!["none", "focus", "ignore"].includes(focus)) {
      return res.status(400).json({ error: 'focus must be "none", "focus" or "ignore"' });
    }
    const settings = updateHostSettings(host, { focus });
    res.json({ ok: true, host, focus: settings.focus });
  });

  /**
   * What is blocked right now.
   *
   * Reads `store.hostSettings` and **not** the host registry, which is the same
   * data one indirection later: the registry is runtime-only and LRU-capped,
   * and its eviction rule spares hosts with SSL or a focus but not hosts kept
   * alive purely by a block rule (`utils/host-registry.js`). A busy session
   * could therefore evict the row for a host whose rules are still on disk and
   * still killing requests — a read that reported nothing while the block fired
   * is worse than no read at all.
   *
   * Three shapes, because a client asks three different questions:
   *   no query        → every host that has rules, `{ host: [paths] }`
   *   `?host=`        → that host's rules, plus whether SSL is even on
   *   `?host=&path=`  → does that path die, and **which rule** kills it
   *
   * The third exists so the prefix rule stays in one place. A client that
   * evaluated it locally would be a third copy of `blockCovering` (after the
   * backend and the tree), free to drift from the one the proxy enforces.
   */
  router.get("/hosts/blocks", (req, res) => {
    const host = typeof req.query.host === "string" ? req.query.host : null;
    const target = typeof req.query.path === "string" ? req.query.path : null;

    if (target !== null && !host) {
      return res.status(400).json({ error: "path requires host" });
    }

    if (!host) {
      const blocks = {};
      for (const [name, settings] of Object.entries(store.hostSettings || {})) {
        if (settings?.blocks?.length) blocks[name] = [...settings.blocks];
      }
      return res.json({ ok: true, blocks });
    }

    const settings = store.hostSettings[host];
    const blocks = settings?.blocks ? [...settings.blocks] : [];
    // Reported on every read: with SSL off the host is tunneled, so the rule is
    // stored and inert. Silently accepting a block that cannot fire is the one
    // way this feature lies to you.
    const payload = { ok: true, host, blocks, ssl: settings?.ssl === true };

    if (target !== null) {
      const normalized = blocking.normalizeBlockPath(target);
      if (!normalized) return res.status(400).json({ error: "path is required" });
      payload.path = normalized;
      payload.rule = blocking.blockCovering(normalized, blocks);
      payload.blocked = payload.rule !== null;
    }

    res.json(payload);
  });

  /**
   * Block or unblock a path on a host.
   *
   * A rule is a **prefix**, so blocking a folder blocks everything under it —
   * see `utils/blocking.js` for why that is one rule and not two. Takes effect
   * on the next request; nothing already in flight is disturbed.
   *
   * Unblocking is exact: it lifts the rule that names this path. A path blocked
   * by an ancestor stays blocked, and the dashboard is what points the action at
   * the rule actually in play — "unblock" on a child silently lifting its whole
   * parent tree is not something anyone asked for.
   */
  router.post("/hosts/block", (req, res) => {
    const { host, path: target, blocked } = req.body || {};
    if (!host || typeof host !== "string") {
      return res.status(400).json({ error: "host is required" });
    }
    if (typeof blocked !== "boolean") {
      return res.status(400).json({ error: "blocked must be a boolean" });
    }
    if (!blocking.normalizeBlockPath(target)) {
      return res.status(400).json({ error: "path is required" });
    }

    const current = store.hostSettings[host]?.blocks || [];
    const blocks = blocked
      ? blocking.addBlock(current, target)
      : blocking.removeBlock(current, target);

    const settings = updateHostSettings(host, { blocks });
    // Worth a line: a blocked path answers nothing at all, and six weeks later
    // "that service is down" is the bug report you get instead.
    console.log(
      `${blocked ? "⛔" : "✅"} [ADMIN] ${blocked ? "Blocked" : "Unblocked"} ${host}${blocking.normalizeBlockPath(target)}`
    );
    // `ssl` rides along so a caller that is not the dashboard — the CLI, a test
    // client — can see the rule it just set is inert: blocking only runs inside
    // the instance app, which a tunneled host never reaches.
    res.json({ ok: true, host, blocks: settings.blocks, ssl: settings.ssl === true });
  });

  /**
   * Forget a host completely: the tree row, its preferences, and the instance
   * behind it — mock toggles, settings and standalone listener included.
   *
   * This used to leave the instance in place so the toggles survived, which is
   * why a "deleted" host kept reappearing across the other sections of
   * state.json. Deleting now means deleting; the dashboard warns about the mock
   * toggles before it gets here.
   */
  router.delete("/hosts/:host", (req, res) => {
    const host = req.params.host;
    const existed = hostRegistry.forget(host);
    const settings = store.hostSettings[host];
    const instanceId = settings?.instanceId || null;
    const hadSettings = Boolean(settings);

    let removedInstance = null;
    if (instanceId && serverConfigs.some((c) => c.id === instanceId)) {
      try {
        removedInstance = instanceManager.removeInstance(instanceId);
        // Otherwise the counters outlive the instance they describe, and a host
        // re-added under the same id would inherit them.
        mockStats.reset({ instanceId });
      } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
      }
    }
    // Unconditional, and after the instance: `removeInstance` keys off the
    // instance's own target host, which is not necessarily the row being
    // deleted. Leaving this behind is precisely the half-erased state the
    // change is meant to end.
    if (hadSettings) {
      delete store.hostSettings[host];
      saveState();
    }

    requestLog.clearLog({ host });
    res.json({
      ok: true,
      host,
      removed: existed || hadSettings,
      instanceId: removedInstance,
    });
  });
};
