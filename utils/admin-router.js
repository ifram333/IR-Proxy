/**
 * Admin Express Router
 * ─────────────────────────────────────────────────────────────────────────────
 * Every `/__admin/*` endpoint, assembled from one module per domain in
 * `utils/admin/`. This file owns two things and nothing else:
 *
 *  • the **context** the domain modules share — the state slices they were all
 *    closing over when this was one 1400-line factory, plus the four helpers
 *    that genuinely have more than one caller;
 *  • the **mount order**.
 *
 * A helper belongs here only when two domains need it. Anything used by one
 * domain lives in that domain's module — `planScopeRewrites` with the instance
 * rename that is its only caller, `loopbackOnly` with the access routes,
 * `mockByName` with the toggles. The rule keeps this file from drifting back
 * into a junk drawer.
 *
 * Routes are registered onto **one** router rather than mounted as sub-routers,
 * so paths stay exactly what they were and nothing depends on mount prefixes.
 */

"use strict";

const express = require("express");
const path = require("path");
const { DEFAULT_HOST_SETTINGS } = require("./interception");

const registerAccess = require("./admin/access");
const registerActivity = require("./admin/activity");
const registerHosts = require("./admin/hosts");
const registerCapture = require("./admin/capture");
const registerSend = require("./admin/send");
const registerCollections = require("./admin/collections");
const registerSchemas = require("./admin/schemas");
const registerMocks = require("./admin/mocks");
const registerToggles = require("./admin/toggles");
const registerInstances = require("./admin/instances");
const registerProfiles = require("./admin/profiles");
const registerProxyInfo = require("./admin/proxy-info");
const registerSystem = require("./admin/system");

/**
 * @param {object} opts
 * @param {string}   opts.MOCKS_DIR     - Absolute path to the mocks directory
 * @param {string}   opts.STATE_FILE    - Absolute path to state.json
 * @param {object}   opts.store         - Shared in-memory state store
 * @param {Array}    opts.serverConfigs - Array of server config objects
 * @param {Function} opts.saveState     - Persists store to STATE_FILE
 * @param {string}   opts.instanceId    - ID of the instance serving this router
 */
module.exports = function createAdminRouter({
  MOCKS_DIR,
  store,
  serverConfigs,
  saveState,
  instanceId,
}) {
  const router = express.Router();

  // `hostSettings` postdates the other store slices, and the router is handed a
  // store by several callers (server.js, proxy-server.js, tests). Normalise it
  // once rather than guarding every read.
  if (!store.hostSettings) store.hostSettings = {};

  // ── Security: prevent path traversal ──────────────────────────────────────
  // Shared by the mock-file routes and by the rename that rewrites their
  // `servers` scopes.
  const safePath = (file) => {
    const resolved = path.resolve(MOCKS_DIR, file);
    const base = path.resolve(MOCKS_DIR);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error("Path traversal attempt blocked");
    }
    return resolved;
  };

  /** Shared by the toggle routes and by the mock-scope rewrite. */
  const knownInstance = (id) => serverConfigs.some((s) => s.id === id);

  // A JSON body sent without `Content-Type: application/json` never gets
  // parsed, which would silently start an UNFILTERED capture session — reject it
  // loudly instead. Fields may alternatively come as query parameters.
  // Shared by the capture routes and by adding an instance.
  const requireJsonBody = (req, res) => {
    const len = parseInt(req.headers["content-length"], 10) || 0;
    if (len > 0 && !req.is("application/json")) {
      res.status(400).json({
        error:
          "Request body was ignored — send it with Content-Type: application/json, or pass the fields as query parameters",
      });
      return false;
    }
    return true;
  };

  /**
   * Read-modify-write one host's durable settings.
   *
   * Shared because adding an instance by hand also turns SSL proxying on for
   * its host — typing a target in means "I want to intercept this".
   */
  const updateHostSettings = (host, patch) => {
    const current = store.hostSettings[host] || { ...DEFAULT_HOST_SETTINGS };
    store.hostSettings[host] = { ...current, ...patch };
    saveState();
    return store.hostSettings[host];
  };

  const ctx = {
    MOCKS_DIR,
    store,
    serverConfigs,
    saveState,
    instanceId,
    safePath,
    knownInstance,
    requireJsonBody,
    updateHostSettings,
  };

  registerAccess(router, ctx);
  registerActivity(router, ctx);
  registerHosts(router, ctx);
  registerCapture(router, ctx);
  registerSend(router, ctx);
  registerCollections(router, ctx);
  registerSchemas(router, ctx);
  registerMocks(router, ctx);
  registerToggles(router, ctx);
  registerInstances(router, ctx);
  registerProfiles(router, ctx);
  registerSystem(router, ctx);
  registerProxyInfo(router, ctx);

  return router;
};
