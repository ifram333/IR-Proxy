/**
 * access-gate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "A machine you aren't sitting at wants to use the admin API. Allow it?"
 *
 * The whole thing turns on one asymmetry: **loopback is the only trusted
 * channel**. Being on the machine already implies the power, so loopback passes
 * without asking and is the only thing that can *grant* access. Without that,
 * the mechanism is decorative — the caller would approve itself.
 *
 * Approval is per **machine**, not per request. Every request from an IP with a
 * decision outstanding waits on that one decision, which is both the right
 * mental model and what stops a browser opening one prompt per XHR.
 *
 * A stateful singleton with a `reset()`, like host-registry and
 * capture-sessions — not a pure module. It holds live `res` objects and timers,
 * so the caps below are load-bearing rather than defensive.
 */

"use strict";

/** Distinct machines that can be waiting at once. Beyond this, deny outright. */
const MAX_PENDING_IPS = 10;
/** Requests that can queue behind one machine's decision. */
const MAX_WAITERS_PER_IP = 50;
/** How long a held request waits before it is denied. */
const TIMEOUT_MS = 60_000;

// Two sets, on purpose. `_allowed` is everything let through right now;
// `_remembered` is the subset that survives a restart. Collapsing them would
// mean any "just this once" approval quietly ends up written to state.json by
// the next unrelated save.
const _allowed = new Set(); // normalised IPs — session + remembered
const _remembered = new Set(); // the ones to persist
const _pending = new Map(); // ip -> { id, ip, path, ua, at, waiters, timer }

let _seq = 0;
let _onChange = null; // (event, payload) => void — injected, keeps sse-hub out
let _persist = null; // () => void

/**
 * Wire up the side effects. `onChange` is called with a named SSE event and its
 * payload; `persist` is called when the remembered set changes.
 */
function configure({ onChange, persist } = {}) {
  _onChange = onChange || null;
  _persist = persist || null;
}

/**
 * Reduce an address to something comparable.
 *
 * Node hands back IPv4-mapped IPv6 (`::ffff:192.168.1.20`) whenever the socket
 * is on a dual-stack listener, and `::1` for IPv6 loopback. Comparing either one
 * raw is a bug that opens or closes too much and does not announce itself.
 */
function normalizeIp(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return "127.0.0.1";
  return ip;
}

/** Loopback, i.e. the machine this process runs on. */
function isLoopback(ip) {
  const norm = normalizeIp(ip);
  return norm === "127.0.0.1" || /^127\./.test(norm || "");
}

/** Has this machine been allowed, this session or from a remembered decision? */
function isAllowed(ip) {
  const norm = normalizeIp(ip);
  return Boolean(norm) && _allowed.has(norm);
}

/** Seed the remembered set at boot. Replaces whatever was there. */
function setRemembered(ips) {
  _remembered.clear();
  (Array.isArray(ips) ? ips : []).forEach((ip) => {
    const norm = normalizeIp(ip);
    if (!norm) return;
    _remembered.add(norm);
    _allowed.add(norm);
  });
}

/** Only the durable approvals — this is what reaches state.json. */
function remembered() {
  return [..._remembered].sort();
}

/** Everything let through right now, durable or not. Diagnostics and the UI. */
function allowedNow() {
  return [..._allowed].sort();
}

function _publicPending(entry) {
  return {
    id: entry.id,
    ip: entry.ip,
    path: entry.path,
    ua: entry.ua,
    at: entry.at,
    waiting: entry.waiters.length,
  };
}

/** Everything currently waiting, so a dashboard opened late still sees it. */
function listPending() {
  return [..._pending.values()].map(_publicPending);
}

function _settle(ip, granted, { remember = false } = {}) {
  const entry = _pending.get(ip);
  if (!entry) return false;

  clearTimeout(entry.timer);
  _pending.delete(ip);

  if (granted) {
    _allowed.add(ip);
    // Remembering is opt-in on purpose: DHCP reassigns addresses, so "allow
    // 192.168.1.20 forever" can quietly become a different device next week.
    if (remember) {
      _remembered.add(ip);
      _persist?.();
    }
  }

  entry.waiters.forEach((resolve) => resolve(granted));
  _onChange?.("access", { type: "resolved", id: entry.id, ip, granted });
  return true;
}

/**
 * Ask for this machine to be let in, and wait for a human.
 *
 * @returns {Promise<boolean>} granted. Resolves false on denial, on timeout, and
 *          immediately when a cap is hit — never rejects, so a caller can always
 *          treat it as a yes/no.
 */
function request({ ip, path, ua } = {}) {
  const norm = normalizeIp(ip);
  if (!norm) return Promise.resolve(false);
  if (_allowed.has(norm)) return Promise.resolve(true);

  const existing = _pending.get(norm);
  if (existing) {
    // Already asking about this machine — join that decision rather than
    // opening a second prompt for the same answer.
    if (existing.waiters.length >= MAX_WAITERS_PER_IP) return Promise.resolve(false);
    return new Promise((resolve) => existing.waiters.push(resolve));
  }

  // Each held request is a live response object plus a timer. Without this cap,
  // a loop of curls is a memory exhaustion attack that needs no credentials.
  if (_pending.size >= MAX_PENDING_IPS) return Promise.resolve(false);

  const entry = {
    id: `acc-${Date.now()}-${++_seq}`,
    ip: norm,
    path: String(path || "/"),
    ua: String(ua || ""),
    at: new Date().toISOString(),
    waiters: [],
    timer: null,
  };

  const promise = new Promise((resolve) => entry.waiters.push(resolve));

  // Denied on timeout, and *not* remembered, so the machine can simply try
  // again once somebody is looking at the screen.
  entry.timer = setTimeout(() => _settle(norm, false), TIMEOUT_MS);
  entry.timer.unref?.();

  _pending.set(norm, entry);
  _onChange?.("access", { type: "pending", ..._publicPending(entry) });

  return promise;
}

/**
 * Answer one pending request, by its id.
 * @returns {boolean} whether there was anything to answer
 */
function decide(id, granted, { remember = false } = {}) {
  for (const entry of _pending.values()) {
    if (entry.id !== id) continue;
    return _settle(entry.ip, Boolean(granted), { remember });
  }
  return false;
}

/** Withdraw a machine's access. Pending requests from it are unaffected. */
function revoke(ip) {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  const wasAllowed = _allowed.delete(norm);
  const wasRemembered = _remembered.delete(norm);
  if (!wasAllowed && !wasRemembered) return false;
  if (wasRemembered) _persist?.();
  _onChange?.("access", { type: "revoked", ip: norm });
  return true;
}

/** Test hygiene: drop every decision and deny anything still waiting. */
function reset() {
  for (const ip of [..._pending.keys()]) _settle(ip, false);
  _allowed.clear();
  _remembered.clear();
  _onChange = null;
  _persist = null;
}

module.exports = {
  MAX_PENDING_IPS,
  MAX_WAITERS_PER_IP,
  TIMEOUT_MS,
  configure,
  normalizeIp,
  isLoopback,
  isAllowed,
  setRemembered,
  remembered,
  allowedNow,
  listPending,
  request,
  decide,
  revoke,
  reset,
};
