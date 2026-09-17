/**
 * sse-hub.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns the set of connected Server-Sent Events clients, the liveness heartbeat,
 * and frame formatting. Extracted from request-log.js so more than one producer
 * can push over the *same* connection: the dashboard needs both request entries
 * and host-registry updates, and opening a second EventSource would double the
 * connections for no reason.
 *
 * Frame naming matters for backwards compatibility:
 *   • Request-log entries are **unnamed** (`data: …`). EventSource delivers those
 *     to `onmessage`, which is what the existing dashboard listens on.
 *   • Everything else is **named** (`event: host\ndata: …`) and is invisible to
 *     an `onmessage`-only client. Older tabs therefore keep working untouched.
 */

"use strict";

// Writing to a dead-but-unclosed SSE connection (e.g. a phone that dropped off
// Wi-Fi without a FIN) never throws — the bytes just pile up in the socket's
// write buffer. Evict a client once its buffer exceeds this, and ping every
// client periodically so the TCP stack surfaces dead connections as 'close'.
const MAX_CLIENT_BUFFER_BYTES = 512 * 1024;
const HEARTBEAT_MS = 30 * 1000;

const _clients = new Set();
let _heartbeatTimer = null;

function _drop(res) {
  _clients.delete(res);
  if (_clients.size === 0 && _heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

/** Write to one client, evicting it if it's dead or hopelessly backed up. */
function writeToClient(res, payload) {
  if (
    res.destroyed ||
    res.writableEnded ||
    (res.writableLength || 0) > MAX_CLIENT_BUFFER_BYTES
  ) {
    _drop(res);
    try {
      res.destroy();
    } catch (_) {
      // Best effort — the client is already being discarded.
    }
    return;
  }
  try {
    res.write(payload);
  } catch (_) {
    _drop(res);
  }
}

/**
 * Format an SSE frame. Omitting `event` produces an unnamed frame.
 * @param {string|null} event
 * @param {*} data serialized as JSON
 */
function frame(event, data) {
  const body = `data: ${JSON.stringify(data)}\n\n`;
  return event ? `event: ${event}\n${body}` : body;
}

/**
 * Push one frame to every connected client.
 * @param {string|null} event  null/undefined for the default (unnamed) channel
 * @param {*} data
 */
function broadcast(event, data) {
  if (_clients.size === 0) return;
  const payload = frame(event, data);
  for (const client of _clients) {
    writeToClient(client, payload);
  }
}

/**
 * Register an SSE response object. Automatically removes it when the client
 * disconnects.
 * @param {import('express').Response} res
 */
function addClient(res) {
  _clients.add(res);
  res.on("close", () => _drop(res));
  if (!_heartbeatTimer) {
    _heartbeatTimer = setInterval(() => {
      // SSE comment line — ignored by EventSource, but forces a TCP write so
      // dead connections get detected and buffer growth gets checked.
      for (const client of _clients) {
        writeToClient(client, ": ping\n\n");
      }
    }, HEARTBEAT_MS);
    // Never keep the process (or Jest) alive just for the heartbeat.
    _heartbeatTimer.unref();
  }
}

/** How many clients are currently connected (diagnostics + tests). */
function clientCount() {
  return _clients.size;
}

module.exports = {
  MAX_CLIENT_BUFFER_BYTES,
  HEARTBEAT_MS,
  addClient,
  broadcast,
  frame,
  writeToClient,
  clientCount,
};
