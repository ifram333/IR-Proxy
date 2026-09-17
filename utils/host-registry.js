/**
 * host-registry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Every host the connected devices reach for, whether or not the proxy decrypts
 * it. This is what the dashboard's left-hand tree is built from.
 *
 * Until now a tunneled host left no trace anywhere: `handlePassThrough` piped
 * bytes and forgot. You could not discover what an app was actually calling, so
 * you could not decide what was worth intercepting. The registry closes that
 * blind spot — it is populated at the two points where the proxy decides
 * MITM-vs-tunnel, *before* the branch, so both outcomes are recorded.
 *
 * Runtime-only, never persisted: a dev browsing through the proxy surfaces
 * hundreds of CDN and analytics hosts. The durable per-host preferences (SSL,
 * focus) live in `store.hostSettings` instead, filtered down to the entries the
 * user actually acted on.
 */

"use strict";

const sseHub = require("./sse-hub");
const { settingsFor } = require("./interception");

// A busy browsing session can touch a lot of hosts. Cap the map and evict the
// least recently seen, but never one the user has committed to (see _evict).
const MAX_HOSTS = 500;

// A browser opening 60 connections at once must not produce 60 SSE frames.
// Coalesce everything seen inside this window into one batched broadcast.
const BROADCAST_THROTTLE_MS = 400;

const _hosts = new Map(); // hostname -> record
const _listeners = new Set();
const _dirty = new Set(); // hostnames changed since the last broadcast
let _flushTimer = null;

// ISO timestamps only resolve to the millisecond, and a browser opens plenty of
// connections inside one. Ordering on `lastSeen` alone leaves ties that sort
// arbitrarily, so rows would jump around the tree on every render. `seq` is the
// monotonic tiebreaker: strictly increasing, bumped on every touch.
let _seq = 0;

/** Read the per-host prefs the registry mirrors onto each record. */
let _readSettings = () => ({});

/**
 * Point the registry at the live `store.hostSettings` object. Called once from
 * server.js; without it every record simply reports the defaults.
 * @param {() => object} getHostSettings
 */
function configure(getHostSettings) {
  _readSettings = getHostSettings || (() => ({}));
}

function _newRecord(host) {
  return {
    host,
    ports: [],
    protocols: [],
    firstSeen: null,
    lastSeen: null,
    seq: 0,
    // Deliberately two counters, not one. With SSL off you only observe CONNECT
    // tunnels, and a single tunnel carries many HTTP requests — reporting those
    // CONNECTs as "requests" would be a lie. The UI shows connections until the
    // host is decrypted, requests after.
    connections: 0,
    requests: 0,
    errors: 0,
  };
}

/** Merge the durable prefs onto a record for consumers (never stored on it). */
function _withSettings(record) {
  const settings = settingsFor(_readSettings(), record.host);
  return { ...record, ...settings };
}

/**
 * Evict down to MAX_HOSTS, oldest-seen first. Hosts the user has committed to
 * (SSL enabled, or explicitly focused) are never evicted — losing those would
 * make a deliberate choice silently vanish from the tree.
 */
function _evict() {
  if (_hosts.size <= MAX_HOSTS) return;
  const settings = _readSettings();

  const evictable = [..._hosts.values()]
    .filter((r) => {
      const s = settingsFor(settings, r.host);
      return !s.ssl && s.focus !== "focus";
    })
    .sort((a, b) => a.seq - b.seq);

  let excess = _hosts.size - MAX_HOSTS;
  for (const record of evictable) {
    if (excess-- <= 0) break;
    _hosts.delete(record.host);
    _dirty.delete(record.host);
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (_dirty.size === 0) return;

    const batch = [];
    for (const host of _dirty) {
      const record = _hosts.get(host);
      if (record) batch.push(_withSettings(record));
    }
    _dirty.clear();
    if (batch.length === 0) return;

    sseHub.broadcast("hosts", batch);
    for (const fn of _listeners) {
      try {
        fn(batch);
      } catch (_) {
        // A listener must never break host tracking.
      }
    }
  }, BROADCAST_THROTTLE_MS);
  // Never keep the process (or Jest) alive just to flush a batch.
  if (_flushTimer.unref) _flushTimer.unref();
}

/**
 * Record that a device reached for this host.
 *
 * Called on the CONNECT hot path, so it must stay cheap and must never touch
 * disk — `saveState` is a synchronous write and has no business here.
 *
 * @param {object} seen
 * @param {string} seen.host
 * @param {number} [seen.port]
 * @param {string} [seen.protocol] "http" | "https"
 * @returns {object|null} the updated record
 */
function seen({ host, port, protocol } = {}) {
  if (!host) return null;

  let record = _hosts.get(host);
  const now = new Date().toISOString();

  if (!record) {
    record = _newRecord(host);
    record.firstSeen = now;
    _hosts.set(host, record);
  }

  record.lastSeen = now;
  record.seq = ++_seq;
  record.connections++;
  if (port && !record.ports.includes(port)) record.ports.push(port);
  if (protocol && !record.protocols.includes(protocol)) record.protocols.push(protocol);

  _dirty.add(host);
  _evict();
  _scheduleFlush();
  return record;
}

/**
 * Make sure a host has a record, without pretending it was contacted.
 *
 * The registry is runtime-only, so a host the user has already committed to
 * (SSL enabled, in `config.js`) would otherwise be invisible in the tree until
 * something happened to hit it — and its settings would be unreachable exactly
 * when you want to set them up. Seeded at boot from `hostSettings`.
 *
 * @param {string} host
 * @returns {object|null}
 */
function ensure(host) {
  if (!host) return null;
  let record = _hosts.get(host);
  if (record) return record;

  record = _newRecord(host);
  // No firstSeen/lastSeen: nothing has actually been observed yet. `seq` still
  // advances so ordering stays well-defined.
  record.seq = ++_seq;
  _hosts.set(host, record);
  _dirty.add(host);
  _scheduleFlush();
  return record;
}

/**
 * Fold a decrypted request into its host's counters. Wired to
 * `requestLog.onEntry` so the registry doesn't need its own hook in the
 * middleware chain.
 * @param {object} entry a request-log record
 */
function noteRequest(entry) {
  if (!entry || !entry.host) return;
  const record = _hosts.get(entry.host) || _newRecord(entry.host);
  if (!_hosts.has(entry.host)) {
    record.firstSeen = entry.timestamp || new Date().toISOString();
    _hosts.set(entry.host, record);
  }

  record.lastSeen = entry.timestamp || new Date().toISOString();
  record.seq = ++_seq;
  record.requests++;
  if (entry.status >= 400 || entry.status === 0) record.errors++;
  if (entry.port && !record.ports.includes(entry.port)) record.ports.push(entry.port);
  if (entry.protocol && !record.protocols.includes(entry.protocol)) {
    record.protocols.push(entry.protocol);
  }

  _dirty.add(entry.host);
  _scheduleFlush();
}

/** Every known host, most recently seen first, with settings merged in. */
function list() {
  return [..._hosts.values()].sort((a, b) => b.seq - a.seq).map(_withSettings);
}

/** One host, or null. */
function get(host) {
  const record = _hosts.get(host);
  return record ? _withSettings(record) : null;
}

/** Reset a host's counters (paired with clearing its log entries). */
function clearCounters(host) {
  const record = _hosts.get(host);
  if (!record) return false;
  record.connections = 0;
  record.requests = 0;
  record.errors = 0;
  _dirty.add(host);
  _scheduleFlush();
  return true;
}

/** Forget a host entirely. Does not touch its settings or its instance. */
function forget(host) {
  _dirty.delete(host);
  return _hosts.delete(host);
}

/** Drop every record (tests, and the dashboard's "clear all"). */
function reset() {
  _hosts.clear();
  _dirty.clear();
  _seq = 0;
}

/**
 * Subscribe to batched host updates.
 * @param {(batch: object[]) => void} fn
 * @returns {() => void} unsubscribe
 */
function onHosts(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Push any pending batch immediately (tests; avoids waiting on the timer). */
function flush() {
  if (!_flushTimer) return;
  clearTimeout(_flushTimer);
  _flushTimer = null;
  const batch = [];
  for (const host of _dirty) {
    const record = _hosts.get(host);
    if (record) batch.push(_withSettings(record));
  }
  _dirty.clear();
  if (batch.length === 0) return;
  sseHub.broadcast("hosts", batch);
  for (const fn of _listeners) {
    try {
      fn(batch);
    } catch (_) {
      /* never break host tracking */
    }
  }
}

module.exports = {
  MAX_HOSTS,
  BROADCAST_THROTTLE_MS,
  configure,
  ensure,
  seen,
  noteRequest,
  list,
  get,
  clearCounters,
  forget,
  reset,
  onHosts,
  flush,
};
