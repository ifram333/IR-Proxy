/**
 * Scenario profiles — named snapshots of every mock toggle.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const instanceManager = require("../instance-manager");

module.exports = function registerProfiles(router, ctx) {
  const { store, saveState } = ctx;

  // ── Scenario Profiles ──────────────────────────────────────────────────────
  router.get("/profiles", (_req, res) => {
    res.json(store.profiles || {});
  });

  router.post("/profiles/save", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).send("Profile name is required");
    // Held to the same standard as an instance label, and for the same reason:
    // this string is rendered in the dashboard, the page that can read every
    // decrypted request. Defence in depth — the chips are built as DOM now, so
    // markup here would be inert, but neither half should be the only one.
    let clean;
    try {
      clean = instanceManager.validateName(name);
    } catch (err) {
      return res.status(err.status || 400).send(err.message);
    }
    if (!store.profiles) store.profiles = {};
    store.profiles[clean] = JSON.parse(JSON.stringify(store.instanceStatus));
    saveState();
    console.log(`💾 [ADMIN] Saved profile: "${clean}"`);
    res.sendStatus(200);
  });

  router.post("/profiles/load", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).send("Profile name is required");
    if (!store.profiles?.[name]) return res.status(404).send("Profile not found");
    Object.assign(store.instanceStatus, JSON.parse(JSON.stringify(store.profiles[name])));
    saveState();
    console.log(`📂 [ADMIN] Loaded profile: "${name}"`);
    res.sendStatus(200);
  });

  router.post("/profiles/delete", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).send("Profile name is required");
    if (!store.profiles?.[name]) return res.status(404).send("Profile not found");
    delete store.profiles[name];
    saveState();
    console.log(`🗑️  [ADMIN] Deleted profile: "${name}"`);
    res.sendStatus(200);
  });
};
