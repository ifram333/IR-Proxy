/**
 * The two snapshot endpoints: `/health` for the badge, `/config` for the dashboard.
 *
 * `/config` is refetched on every repaint, which is why anything that changes on a
 * different rhythm — the mock hit counters — has an endpoint of its own.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const loadMocks = require("../mock-loader");
const requestLog = require("../request-log");
const standaloneManager = require("../standalone-manager");
const { findConflicts } = require("../mock-conflicts");

module.exports = function registerSystem(router, ctx) {
  const { MOCKS_DIR, store, serverConfigs, instanceId } = ctx;

  // ── Health check ───────────────────────────────────────────────────────────
  router.get("/health", (_req, res) => {
    const mocks = loadMocks(MOCKS_DIR);
    res.json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      instances: serverConfigs.map((c) => ({
        id: c.id,
        port: c.port,
        name: c.name,
        isActive: store.instanceSettings[c.id]?.isActive ?? true,
        latency: store.instanceSettings[c.id]?.latency || 0,
      })),
      mockCount: mocks.length,
      standaloneInstances: standaloneManager.isEnabled(),
      // What the activity log is costing, so "why is this process at 200 MB?"
      // is answerable without attaching a profiler.
      log: requestLog.stats(),
      rss: process.memoryUsage().rss,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Config snapshot (used by the dashboard) ────────────────────────────────
  router.get("/config", (_req, res) => {
    const mockRegistry = loadMocks(MOCKS_DIR);

    const conflictSet = findConflicts(mockRegistry);

    res.json({
      instances: serverConfigs,
      mocks: mockRegistry.map((m) => ({
        name: m.name,
        file: m.file,
        folder: m.folder,
        delay: m.delay || 0,
        servers: m.servers || null,
        hasConflict: conflictSet.has(m.name),
      })),
      states: store.instanceStatus,
      instanceSettings: store.instanceSettings,
      hostSettings: store.hostSettings || {},
      profiles: store.profiles || {},
      standaloneInstances: standaloneManager.isEnabled(),
      currentInstanceId: instanceId,
    });
  });
};
