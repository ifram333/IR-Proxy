/**
 * standalone-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin mediator that lets the admin router (and CLI, via its endpoints) start
 * and stop the optional direct per-instance servers (:3000/:3001/:3002) at
 * runtime, without the router needing to know how they're built.
 *
 * `server.js` owns the actual start/stop implementation and injects it here via
 * `configure()`. This keeps the dependency one-directional (server.js → router)
 * and avoids a circular require between admin-router and server.js.
 */

"use strict";

let _impl = null; // { isEnabled(), enable(), disable(), sync() }

/** Wire up the real start/stop implementation (called once from server.js). */
function configure(impl) {
  _impl = impl;
}

/** Whether the standalone servers are currently running. */
function isEnabled() {
  return _impl ? !!_impl.isEnabled() : false;
}

/** Start the standalone servers (no-op if already running). */
function enable() {
  if (!_impl) throw new Error("Standalone manager is not configured");
  return _impl.enable();
}

/** Stop the standalone servers (no-op if not running). */
function disable() {
  if (!_impl) throw new Error("Standalone manager is not configured");
  return _impl.disable();
}

/**
 * Reconcile the running listeners with what is currently eligible.
 *
 * A host's listener follows its SSL-proxying flag, so this is called after the
 * routes that flip it. Deliberately forgiving: unlike enable/disable it is a
 * side effect of some *other* action, and an unconfigured manager (tests that
 * mount the router alone) shouldn't turn that action into a 500.
 */
function sync() {
  if (_impl && typeof _impl.sync === "function") _impl.sync();
}

module.exports = { configure, isEnabled, enable, disable, sync };
