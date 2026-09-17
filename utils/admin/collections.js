/**
 * Collections — named, ordered groups of saved requests.
 *
 * Thin over `collection-store`: this validates names to the same standard every
 * other client-supplied label is held to, and resolves ids into records for the
 * screen. The store owns the on-disk layout and the ordering rules.
 *
 * There is deliberately **no run endpoint**. Running a collection is the
 * dashboard sending its requests through `/send`, one at a time, in order —
 * which means every guarantee `/send` already makes (the host comes from the
 * instance, the 409 when SSL is off, the call landing in the activity log)
 * applies unchanged, progress appears row by row as it happens, and stopping a
 * run halfway is a client-side flag rather than server state nobody is watching.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const collectionStore = require("../collection-store");
const requestStore = require("../request-store");
const instanceManager = require("../instance-manager");

module.exports = function registerCollections(router) {
  /** Everything the collections screen renders, in one call. */
  router.get("/collections", (_req, res) => {
    const { collections, ungrouped } = collectionStore.groupRequests(
      collectionStore.list(),
      requestStore.list()
    );
    res.json({ collections, ungrouped });
  });

  router.post("/collections", (req, res) => {
    let name;
    try {
      // Rendered in the dashboard — the page that can read every decrypted
      // request — so it meets the same bar as an instance or profile label.
      name = instanceManager.validateName(req.body?.name);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    try {
      const created = collectionStore.create(name);
      console.log(`📁 [ADMIN] Created collection "${created.name}"`);
      res.json({ ok: true, collection: created });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.patch("/collections/:id", (req, res) => {
    let name;
    try {
      name = instanceManager.validateName(req.body?.name);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const renamed = collectionStore.rename(req.params.id, name);
    if (!renamed) {
      return res.status(404).json({ error: "That collection no longer exists" });
    }
    res.json({ ok: true, collection: renamed });
  });

  router.delete("/collections/:id", (req, res) => {
    if (!collectionStore.remove(req.params.id)) {
      return res.status(404).json({ error: "That collection no longer exists" });
    }
    // Worth saying out loud: deleting the group is not deleting the requests.
    console.log(`🗑  [ADMIN] Deleted collection "${req.params.id}" (requests kept)`);
    res.json({ ok: true, id: req.params.id });
  });

  /**
   * Every membership change, through one route: adding a request to a
   * collection, moving it to another, reordering it inside one, and taking it
   * out (`collectionId: null`) are the same operation with different arguments.
   * One route means one place the "at most one collection" rule is enforced.
   */
  router.post("/collections/assign", (req, res) => {
    const { requestId, collectionId = null, index } = req.body || {};

    // Checked here rather than in the store: only this layer can tell the
    // difference between "no such request" and "an id shaped wrong", and the
    // screen wants to hear the first one.
    if (!requestStore.get(requestId)) {
      return res.status(404).json({ error: "That saved request no longer exists" });
    }

    try {
      collectionStore.assign(requestId, collectionId, index);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
};
