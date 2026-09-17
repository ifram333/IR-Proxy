/**
 * Schema files — the `schemas/` directory, over HTTP.
 *
 * Thin over `schema-store`: this validates the name to the same standard every
 * other client-supplied label is held to, and — the part that matters — runs
 * every schema past `schema-validate.assertSupported` **before it is written**.
 *
 * That check is the reason these routes exist rather than telling people to
 * drop a file in the directory themselves. A schema saved through here cannot
 * be one the runner would refuse: the refusal lands while you are still looking
 * at the editor, which is the same bargain `POST /saved-requests` makes for a
 * stored expectation. A file put there by hand still gets refused, just later —
 * on the send, by the same function.
 *
 * The store owns the on-disk layout, and there is deliberately not much of one:
 * the file is the schema, so what these routes move around is a plain JSON
 * Schema document in both directions.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const schemaStore = require("../schema-store");
const schemaValidate = require("../schema-validate");
const instanceManager = require("../instance-manager");

module.exports = function registerSchemas(router) {
  /** The picker's list: ids, names and filesystem facts — not the documents. */
  router.get("/schemas", (_req, res) => {
    res.json({ schemas: schemaStore.list(), dir: schemaStore.dir() });
  });

  router.get("/schemas/:id", (req, res) => {
    const schema = schemaStore.get(req.params.id);
    if (!schema) {
      return res.status(404).json({ error: "That schema file no longer exists" });
    }
    res.json({ id: req.params.id, schema });
  });

  router.post("/schemas", (req, res) => {
    const { name, schema } = req.body || {};

    let clean;
    try {
      // Rendered in the dashboard — the page that can read every decrypted
      // request — so it meets the same bar as an instance or profile label.
      clean = instanceManager.validateName(name);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    try {
      // Before the write, never after: a file this validator would refuse is a
      // file that fails halfway through somebody's run instead of here.
      schemaValidate.assertSupported(schema);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    try {
      const saved = schemaStore.save(clean, schema);
      console.log(`📐 [ADMIN] Saved schema "${saved.id}${schemaStore.SUFFIX}"`);
      res.json({ ok: true, ...saved });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete("/schemas/:id", (req, res) => {
    if (!schemaStore.remove(req.params.id)) {
      return res.status(404).json({ error: "That schema file no longer exists" });
    }
    // Worth saying out loud: the requests that reference it keep their own copy
    // of the expectation, so deleting the file doesn't disarm any check.
    console.log(`🗑  [ADMIN] Deleted schema "${req.params.id}"`);
    res.json({ ok: true, id: req.params.id });
  });
};
