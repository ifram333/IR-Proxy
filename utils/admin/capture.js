/**
 * Capture sessions, for test automation.
 *
 * Tests mark a START, exercise the app through the proxy, mark an END, and assert
 * on what was captured. See clients/README.md for the contract.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const captureSessions = require("../capture-sessions");

module.exports = function registerCapture(router, ctx) {
  const { serverConfigs, requireJsonBody } = ctx;

  // ── Capture sessions (test automation) ─────────────────────────────────────
  // Automated tests mark a START, exercise the app through the proxy, mark an
  // END, and assert on the captured requests. Sessions accumulate entries as
  // they are logged, so the rolling activity-log cap never drops data from an
  // active window. See clients/README.md for the contract and client helpers.

  router.post("/capture/start", (req, res) => {
    if (!requireJsonBody(req, res)) return;
    const body = req.body || {};
    const name = body.name || req.query.name;
    const filterInstance = body.instanceId || req.query.instanceId;
    if (filterInstance && !serverConfigs.find((c) => c.id === filterInstance)) {
      return res
        .status(404)
        .json({ error: `Instance "${filterInstance}" is not configured` });
    }
    try {
      const meta = captureSessions.startSession({
        name,
        instanceId: filterInstance,
      });
      res.json({
        ok: true,
        sessionId: meta.id,
        name: meta.name,
        startedAt: meta.startedAt,
        filter: meta.filter,
      });
    } catch (err) {
      if (err.code === "CAPACITY") return res.status(429).json({ error: err.message });
      throw err;
    }
  });

  // Idempotent: stopping an already-stopped/expired session returns its data
  // unchanged. Entries come back inline (chronological, oldest first) so the
  // common flow is a single round-trip, immune to later session eviction.
  router.post("/capture/stop", (req, res) => {
    if (!requireJsonBody(req, res)) return;
    const sessionId = (req.body || {}).sessionId || req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: "Required field: sessionId" });
    }
    const session = captureSessions.stopSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: `Capture session "${sessionId}" not found` });
    }
    res.json({
      ok: true,
      sessionId: session.id,
      name: session.name,
      status: session.status,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      count: session.entries.length,
      droppedCount: session.droppedCount,
      requests: session.entries,
    });
  });

  router.get("/capture", (_req, res) => {
    res.json({ ok: true, sessions: captureSessions.listSessions() });
  });

  router.get("/capture/:sessionId", (req, res) => {
    const session = captureSessions.getSession(req.params.sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ error: `Capture session "${req.params.sessionId}" not found` });
    }
    res.json({ ok: true, session: captureSessions.sessionMeta(session) });
  });

  router.get("/capture/:sessionId/requests", (req, res) => {
    const session = captureSessions.getSession(req.params.sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ error: `Capture session "${req.params.sessionId}" not found` });
    }
    const requests = captureSessions.getRequests(req.params.sessionId, {
      method: req.query.method,
      path: req.query.path,
      pathPrefix: req.query.pathPrefix,
      instanceId: req.query.instanceId,
      source: req.query.source,
    });
    res.json({
      ok: true,
      sessionId: session.id,
      status: session.status,
      count: requests.length,
      droppedCount: session.droppedCount,
      requests,
    });
  });

  router.delete("/capture/:sessionId", (req, res) => {
    if (!captureSessions.deleteSession(req.params.sessionId)) {
      return res
        .status(404)
        .json({ error: `Capture session "${req.params.sessionId}" not found` });
    }
    res.json({ ok: true, sessionId: req.params.sessionId });
  });
};
