/**
 * The activity log, the SSE stream that carries it, and the pause switch.
 *
 * Also the per-mock hit counters: they ride the same `requestLog.onEntry` hook but
 * are deliberately independent of the log's rolling window, so the evidence that a
 * mock fired outlives the requests that pushed it out.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const requestLog = require("../request-log");
const hostRegistry = require("../host-registry");
const mockStats = require("../mock-stats");

module.exports = function registerActivity(router, _ctx) {
  // ── SSE: real-time activity stream ─────────────────────────────────────────
  router.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");
    requestLog.addSSEClient(res);
  });

  /**
   * How many times each mock has answered, this run.
   *
   * Its own endpoint rather than a field on `/config`: that payload already
   * carries the whole mock registry and is refetched on every repaint, while
   * this is small and changes on a different rhythm.
   */
  router.get("/mock-stats", (_req, res) => {
    res.json({ stats: mockStats.summary() });
  });

  /** Forget the counters — all of them, or one instance's. */
  router.post("/mock-stats/reset", (req, res) => {
    const { instanceId } = req.body || {};
    res.json({ ok: true, removed: mockStats.reset({ instanceId }) });
  });

  router.get("/log-history", (req, res) => {
    res.json(requestLog.getHistory(parseInt(req.query.limit) || 100));
  });

  // No body clears everything (the long-standing behaviour the CLI and the
  // dashboard's Clear button depend on). `{ host }` / `{ instanceId }` narrows
  // it to one host — the per-host "Clear log" action in the tree.
  router.post("/log-clear", (req, res) => {
    const { host, instanceId: onlyInstance } = req.body || {};
    const removed = requestLog.clearLog({ host, instanceId: onlyInstance });
    if (host) hostRegistry.clearCounters(host);
    res.json({ ok: true, removed });
  });

  /**
   * Stop or resume recording without touching the proxy.
   *
   * Traffic keeps flowing and mocks keep firing; nothing is retained. This is
   * what you want before pushing a load test through the proxy — the log is
   * where the memory goes, and the hits table renders from it.
   */
  router.post("/log-paused", (req, res) => {
    const { paused } = req.body || {};
    if (typeof paused !== "boolean") {
      return res.status(400).json({ error: "paused must be a boolean" });
    }
    requestLog.setPaused(paused);
    console.log(paused ? "⏸️  [Log] Recording paused." : "▶️  [Log] Recording resumed.");
    res.json({ ok: true, paused, stats: requestLog.stats() });
  });
};
