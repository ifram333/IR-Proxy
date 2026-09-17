/**
 * Which mocks are live, per instance.
 *
 * A mock applies to an instance when it has no scope or lists it — the same rule
 * `inScope` uses in mock-pipeline.js. A toggle for a mock that doesn't apply is
 * refused rather than silently stored somewhere it can never take effect.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const loadMocks = require("../mock-loader");

module.exports = function registerToggles(router, ctx) {
  const { MOCKS_DIR, store, saveState, knownInstance } = ctx;

  // ── Validation helpers ────────────────────────────────────────────────────

  const mockByName = (name) => loadMocks(MOCKS_DIR).find((m) => m.name === name);
  // A mock applies to an instance when it has no scope or lists that instance.
  const inInstanceScope = (mock, id) => !mock?.servers || mock.servers.includes(id);

  // ── Toggle helpers ─────────────────────────────────────────────────────────
  router.post("/toggle", (req, res) => {
    const { instanceId: id, mockName, enabled } = req.body;
    if (!id || mockName === undefined || enabled === undefined) {
      return res
        .status(400)
        .json({ error: "Required fields: instanceId, mockName, enabled" });
    }
    if (!knownInstance(id))
      return res.status(404).json({ error: `Instance "${id}" not found` });
    const mock = mockByName(mockName);
    if (!mock) return res.status(404).json({ error: `Mock "${mockName}" not found` });
    if (!inInstanceScope(mock, id))
      return res.status(409).json({
        error: `Mock "${mockName}" does not apply to instance "${id}"`,
      });
    if (!store.instanceStatus[id]) store.instanceStatus[id] = {};
    store.instanceStatus[id][mockName] = enabled;
    saveState();
    res.json({ ok: true, instanceId: id, mockName, enabled });
  });

  router.post("/toggle-bulk", (req, res) => {
    const { instanceId: id, mockNames, enabled } = req.body;
    if (!id || !Array.isArray(mockNames) || enabled === undefined) {
      return res
        .status(400)
        .json({ error: "Required fields: instanceId, mockNames (array), enabled" });
    }
    if (!knownInstance(id))
      return res.status(404).json({ error: `Instance "${id}" not found` });
    if (!store.instanceStatus[id]) store.instanceStatus[id] = {};
    const toggled = [];
    mockNames.forEach((name) => {
      // Skip mocks that don't apply to this instance.
      if (!inInstanceScope(mockByName(name), id)) return;
      store.instanceStatus[id][name] = enabled;
      toggled.push(name);
    });
    saveState();
    res.json({
      ok: true,
      instanceId: id,
      enabled,
      count: toggled.length,
      mocks: toggled,
    });
  });

  // Toggle by the file path of the mock instead of by name
  router.post("/toggle-by-path", (req, res) => {
    const { instanceId: id, path: mockPath, enabled } = req.body;
    if (!id || !mockPath || enabled === undefined) {
      return res
        .status(400)
        .json({ error: "Required fields: instanceId, path, enabled" });
    }
    if (!knownInstance(id))
      return res.status(404).json({ error: `Instance "${id}" not found` });
    const mockRegistry = loadMocks(MOCKS_DIR);
    const mock = mockRegistry.find(
      (m) => m.file === mockPath || m.file === mockPath.replace(/\.mock\.js$/, "")
    );
    if (!mock)
      return res.status(404).json({ error: `Mock with path "${mockPath}" not found` });
    if (!store.instanceStatus[id]) store.instanceStatus[id] = {};
    store.instanceStatus[id][mock.name] = enabled;
    saveState();
    res.json({ ok: true, instanceId: id, mockName: mock.name, file: mock.file, enabled });
  });

  router.get("/state/:instanceId", (req, res) => {
    const id = req.params.instanceId;
    if (!knownInstance(id))
      return res.status(404).json({ error: `Instance "${id}" not found` });
    const states = store.instanceStatus[id] || {};
    const settings = store.instanceSettings[id];
    const onCount = Object.values(states).filter(Boolean).length;
    const offCount = Object.values(states).filter((v) => v === false).length;
    res.json({
      instanceId: id,
      isActive: settings?.isActive ?? true,
      targetUrl: settings?.targetUrl || "",
      latency: settings?.latency || 0,
      summary: {
        on: onCount,
        off: offCount,
        unset: loadMocks(MOCKS_DIR).length - onCount - offCount,
      },
      states,
    });
  });
};
