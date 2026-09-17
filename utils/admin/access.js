/**
 * Access-approval routes.
 *
 * These sit OUTSIDE the gate (see UNGATED in proxy-server.js) and enforce loopback
 * themselves, because only the machine running the proxy may grant access.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const accessGate = require("../access-gate");

module.exports = function registerAccess(router, _ctx) {
  // ── Access approval ────────────────────────────────────────────────────────
  // These sit OUTSIDE the gate (see ALLOWLIST in proxy-server.js) and enforce
  // loopback themselves. Both halves are needed: routed through the gate, a
  // remote caller asking to approve itself would surface as an ordinary
  // "someone wants in" prompt, and one careless click would hand them the keys.
  const loopbackOnly = (req, res, next) => {
    if (accessGate.isLoopback(req.socket.remoteAddress)) return next();
    res.status(403).json({
      error: "Access decisions can only be made from the machine running the proxy.",
    });
  };

  router.get("/access", loopbackOnly, (_req, res) => {
    res.json({
      pending: accessGate.listPending(),
      allowed: accessGate.allowedNow(),
      remembered: accessGate.remembered(),
    });
  });

  router.post("/access/decision", loopbackOnly, (req, res) => {
    const { id, allow, remember } = req.body || {};
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "id is required" });
    }
    if (typeof allow !== "boolean") {
      return res.status(400).json({ error: "allow must be a boolean" });
    }
    // Persistence is the gate's own business — it only writes when `remember`
    // was ticked, and doing it here too would put session-only approvals on disk.
    const answered = accessGate.decide(id, allow, { remember: remember === true });
    if (!answered) {
      // Already timed out, or answered from another tab.
      return res.status(404).json({ error: "That request is no longer waiting." });
    }
    res.json({ ok: true, id, allow });
  });

  router.delete("/access/:ip", loopbackOnly, (req, res) => {
    res.json({ ok: true, ip: req.params.ip, revoked: accessGate.revoke(req.params.ip) });
  });
};
