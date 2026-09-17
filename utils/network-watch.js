/**
 * network-watch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Notices when this machine's LAN addresses change.
 *
 * The address is printed at startup and typed into every device's proxy
 * settings, so when the router hands out a different one — after a power cut,
 * a lease expiry, a VPN connecting — everything on screen is quietly wrong and
 * every configured phone is pointing at nothing. Nothing about that announces
 * itself, which is what makes it worth watching for.
 *
 * Polled, because Node has no portable "the network changed" event.
 * `os.networkInterfaces()` is a cheap syscall and an address change is a
 * once-in-a-while event, so the interval is generous.
 *
 * `readInterfaces` is injectable so this can be tested without a network.
 */

"use strict";

const os = require("os");

/** Generous on purpose: this catches a rare event, it doesn't race anything. */
const DEFAULT_INTERVAL_MS = 15_000;

let _timer = null;
let _known = [];
let _read = () => os.networkInterfaces();

/**
 * Every non-internal IPv4 address, sorted.
 *
 * Sorted so the comparison is set-like: interface enumeration order isn't
 * stable across platforms, and a reshuffle is not a change.
 */
function localIPs(readInterfaces = _read) {
  return Object.values(readInterfaces() || {})
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address)
    .sort();
}

const _same = (a, b) => a.length === b.length && a.every((ip, i) => ip === b[i]);

/**
 * Begin watching. `onChange({ from, to })` fires only when the set differs.
 *
 * Idempotent: calling it again restarts the watch rather than stacking timers.
 */
function start({ onChange, intervalMs = DEFAULT_INTERVAL_MS, readInterfaces } = {}) {
  stop();
  if (readInterfaces) _read = readInterfaces;
  _known = localIPs();

  _timer = setInterval(() => {
    const current = localIPs();
    if (_same(current, _known)) return;
    const from = _known;
    _known = current;
    try {
      onChange?.({ from, to: current });
    } catch (err) {
      // A listener must never take the watcher down with it.
      console.error("🔴 [Network] change handler failed:", err.message);
    }
  }, intervalMs);

  // Never keep the process — or Jest — alive just to watch for this.
  _timer.unref?.();
  return _known;
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/** The addresses as of the last check. */
function current() {
  return [..._known];
}

/** Tests: forget the interval, the cache and any injected reader. */
function reset() {
  stop();
  _known = [];
  _read = () => os.networkInterfaces();
}

module.exports = { DEFAULT_INTERVAL_MS, localIPs, start, stop, current, reset };
