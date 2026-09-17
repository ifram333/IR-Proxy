/**
 * entries.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The live data layer: request entries and the host registry, both arriving
 * over one EventSource.
 *
 * Request entries come in on the default (unnamed) channel; host updates on the
 * named `hosts` channel. One connection, two streams — see utils/sse-hub.js.
 *
 * Renders are coalesced into a single animation frame: a device behind the
 * proxy can produce dozens of entries per second and re-rendering the tree per
 * message would make the UI unusable exactly when you most need it.
 */
import { state } from "./state.js";
import { api, getApiUrl, toast } from "./util.js";

// Keep roughly what the server keeps. The tree groups by path, so a big buffer
// costs little visually but keeps "what happened five minutes ago" available.
const MAX_CLIENT_ENTRIES = 1000;

let _es = null;
let _reconnectTimer = null;
let _renderScheduled = false;
let _onChange = () => {};
let _onAccess = null;
let _onNetwork = null;

/** Register the callback fired (once per frame) whenever data changes. */
export function onDataChange(fn) {
  _onChange = fn || (() => {});
}

/** Register the handler for access-approval frames. Not coalesced: each one is
 *  a person waiting on an answer, not a repaint. */
export function onAccessEvent(fn) {
  _onAccess = fn || null;
}

/** Register the handler for "this machine's address changed" frames. */
export function onNetworkEvent(fn) {
  _onNetwork = fn || null;
}

function scheduleRender() {
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(() => {
    _renderScheduled = false;
    _onChange();
  });
}

/** Force an immediate re-render (after an action whose result must show now). */
export function refresh() {
  _onChange();
}

// ── Initial load ─────────────────────────────────────────────────

export async function fetchLogHistory() {
  try {
    const res = await fetch(getApiUrl("/__admin/log-history?limit=1000"));
    if (res.ok) {
      state.allLogs = await res.json();
      scheduleRender();
    }
  } catch (err) {
    console.error("Failed to load log history", err);
  }
}

export async function fetchHosts() {
  try {
    const res = await fetch(getApiUrl("/__admin/hosts"));
    if (res.ok) {
      const { hosts } = await res.json();
      state.hosts = hosts || [];
      scheduleRender();
    }
  } catch (err) {
    console.error("Failed to load hosts", err);
  }
}

// ── Live stream ──────────────────────────────────────────────────

/**
 * One EventSource for the page. It reconnects transient drops on its own; we
 * only rebuild once the browser gives up (CLOSED), and always close the old
 * instance first so connections never stack up on the server.
 */
export function connectSSE() {
  if (typeof EventSource === "undefined") return;
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  if (_es) _es.close();

  _es = new EventSource(getApiUrl("/__admin/events"));

  _es.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      state.allLogs.unshift(entry);
      if (state.allLogs.length > MAX_CLIENT_ENTRIES) state.allLogs.pop();
      scheduleRender();
    } catch (_) {
      // A malformed frame must not kill the stream.
    }
  };

  _es.addEventListener("hosts", (event) => {
    try {
      const batch = JSON.parse(event.data);
      mergeHosts(batch);
      scheduleRender();
    } catch (_) {
      /* ignore */
    }
  });

  // A machine that isn't this one wants into the admin API. Forwarded rather
  // than handled here: this module owns the connection, not the UI.
  _es.addEventListener("access", (event) => {
    try {
      _onAccess?.(JSON.parse(event.data));
    } catch (_) {
      /* ignore */
    }
  });

  // This machine's LAN address changed — every device pointed at the old one is
  // now talking to nothing, so it can't wait for the 30s health poll.
  _es.addEventListener("network", (event) => {
    try {
      _onNetwork?.(JSON.parse(event.data));
    } catch (_) {
      /* ignore */
    }
  });

  _es.onerror = () => {
    if (_es.readyState !== EventSource.CLOSED || _reconnectTimer) return;
    _reconnectTimer = setTimeout(connectSSE, 5000);
  };
}

/**
 * Fold a batch of host records into the local list, replacing matches by
 * hostname and prepending anything new (the server sends most-recent first).
 */
function mergeHosts(batch) {
  if (!Array.isArray(batch)) return;
  const byHost = new Map(state.hosts.map((h) => [h.host, h]));
  batch.forEach((record) => byHost.set(record.host, record));
  state.hosts = [...byHost.values()].sort((a, b) => (b.seq || 0) - (a.seq || 0));
}

// ── Mutations ────────────────────────────────────────────────────

/** Clear every entry, or just one host's. */
export async function clearEntries(host) {
  await api("/__admin/log-clear", {
    method: "POST",
    body: host ? { host } : {},
  });

  if (host) {
    state.allLogs = state.allLogs.filter((e) => e.host !== host);
    const record = state.hosts.find((h) => h.host === host);
    if (record) Object.assign(record, { connections: 0, requests: 0, errors: 0 });
    toast(`Cleared ${host}`, "info");
  } else {
    state.allLogs = [];
    state.hosts.forEach((h) =>
      Object.assign(h, { connections: 0, requests: 0, errors: 0 })
    );
    toast("Log cleared", "info");
  }
  refresh();
}

/**
 * Turn SSL proxying on or off for a host.
 *
 * Enabling promotes the host to an instance server-side, so the instance list
 * the rest of the dashboard reads has changed — the caller reloads config.
 */
export async function setHostSsl(host, enabled) {
  const res = await api("/__admin/hosts/ssl", {
    method: "POST",
    body: { host, enabled },
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    toast(error || "Could not change SSL proxying", "error");
    return false;
  }

  const { instanceId } = await res.json();
  const record = state.hosts.find((h) => h.host === host);
  if (record) Object.assign(record, { ssl: enabled, instanceId });

  toast(
    enabled
      ? `SSL proxying on for ${host} — new connections will be decrypted`
      : `SSL proxying off for ${host}`,
    enabled ? "success" : "info"
  );
  return true;
}

/**
 * Can this request be replayed, and if not, why?
 *
 * Both right-click menus (the tree's leaves and the inspector's hits table)
 * need this and had grown their own spelling of it, which is exactly how the
 * two drift apart. The rule lives here; each menu still decides how to present
 * it.
 *
 * @param {object} entry a request-log record
 * @returns {{retry: boolean, edit: boolean, reason: string}}
 */
export function replayability(entry) {
  if (!entry) return { retry: false, edit: false, reason: "" };

  const host = state.hosts.find((h) => h.host === entry.host);
  // A tunneled host never reaches the mock pipeline, so a replay would go
  // straight upstream — the server refuses it too.
  if (host && !host.ssl) return { retry: false, edit: false, reason: "SSL off" };
  // A body cut at the storage cap would be sent incomplete. Editing is the way
  // out of that, since you supply a complete one.
  if (entry.requestTruncated) {
    return { retry: false, edit: true, reason: "body truncated" };
  }
  return { retry: true, edit: true, reason: "" };
}

/** Move a host between the tree's Focused / normal / Ignored sections. */
/**
 * Block or unblock a path on a host — calls to it are killed outright.
 *
 * The record is patched from the response rather than from what we asked for:
 * the server collapses rules a broader one now covers, so assuming our own
 * argument would leave the tree showing a rule that no longer exists.
 *
 * @param {string} host
 * @param {string} path
 * @param {boolean} blocked
 */
export async function setPathBlocked(host, path, blocked) {
  const res = await api("/__admin/hosts/block", {
    method: "POST",
    body: { host, path, blocked },
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    toast(error || "Could not change the block", "error");
    return false;
  }
  const { blocks } = await res.json();
  const record = state.hosts.find((h) => h.host === host);
  if (record) record.blocks = blocks;
  refresh();
  toast(blocked ? `Blocked ${path}` : `Unblocked ${path}`, blocked ? "warning" : "info");
  return true;
}

export async function setHostFocus(host, focus) {
  const res = await api("/__admin/hosts/focus", {
    method: "POST",
    body: { host, focus },
  });
  if (!res.ok) {
    toast("Could not update the host", "error");
    return false;
  }
  const record = state.hosts.find((h) => h.host === host);
  if (record) record.focus = focus;
  refresh();
  return true;
}

/** Drop a host from the tree entirely (its instance and mocks are untouched). */
export async function forgetHost(host) {
  const res = await api(`/__admin/hosts/${encodeURIComponent(host)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    toast("Could not remove the host", "error");
    return false;
  }
  state.hosts = state.hosts.filter((h) => h.host !== host);
  state.allLogs = state.allLogs.filter((e) => e.host !== host);
  refresh();
  return true;
}

/**
 * Say how it went, once, for both routes.
 *
 * A send that came back is a success even when the response failed its
 * expectation — the request went out and an answer arrived. Calling that
 * "Sent ✓" would be the toast contradicting the red row the caller is about to
 * paint, so the wording follows the check when there was one.
 *
 * @returns {{failedExpectation?: boolean}} folded into the caller's result
 */
function announce(payload, verb) {
  if (payload.expect && !payload.expect.passed) {
    const n = payload.expect.errors.length;
    toast(`${verb}, but the response failed its check (${n})`, "warning");
    return { failedExpectation: true };
  }
  toast(`${verb} — watch for the new entry`, "success");
  return {};
}

/**
 * Re-send a captured request through the proxy ("Retry" in the tree menu).
 *
 * @param {string} id
 * @param {object} [overrides] `{ method, path, headers, body }` from the
 *   Retry-with-modifications editor. The host is never overridable.
 * @returns {Promise<{ok: boolean, error?: string}>} the reason is returned as
 *   well as toasted, so a caller with somewhere better to show it (the editor
 *   modal) can keep it on screen instead of letting it fade.
 */
export async function replayEntry(id, overrides, expectation, variables) {
  let res;
  try {
    res = await api("/__admin/replay", {
      method: "POST",
      // `expect` and `variables` ride at the top level, not inside
      // `overrides`: neither is an edit to what was captured. One is a question
      // about the answer; the other is what the braces in it stand for — and
      // sending it inside `overrides` would see it silently dropped, since the
      // field validator reads only method, path, headers and body.
      body: {
        id,
        ...(overrides ? { overrides } : {}),
        ...(expectation ? { expect: expectation } : {}),
        ...(variables ? { variables } : {}),
      },
    });
  } catch (err) {
    const error = err.message || "Could not reach the proxy";
    toast(error, "error");
    return { ok: false, error };
  }

  if (res.ok) {
    const payload = await res.json().catch(() => ({}));
    return { ok: true, expect: payload.expect, ...announce(payload, "Replayed") };
  }

  const { error } = await res.json().catch(() => ({}));
  const message = error || `Replay failed (HTTP ${res.status})`;
  toast(message, "error");
  return { ok: false, error: message };
}

/**
 * Send a request composed from scratch ("New request").
 *
 * The same loop-back-through-the-proxy path as `replayEntry`, minus the
 * captured entry: with nothing to inherit, the instance is chosen and travels
 * in the body instead of being derived from a log id.
 *
 * @param {object} req `{ instanceId, method, path, headers, body }`
 * @returns {Promise<{ok: boolean, error?: string}>} the reason is returned as
 *   well as toasted, so the editor modal can keep it on screen.
 */
export async function sendComposed(req) {
  let res;
  try {
    res = await api("/__admin/send", { method: "POST", body: req });
  } catch (err) {
    const error = err.message || "Could not reach the proxy";
    toast(error, "error");
    return { ok: false, error };
  }

  if (res.ok) {
    const payload = await res.json().catch(() => ({}));
    return { ok: true, expect: payload.expect, ...announce(payload, "Sent") };
  }

  const { error } = await res.json().catch(() => ({}));
  const message = error || `Request failed (HTTP ${res.status})`;
  toast(message, "error");
  return { ok: false, error: message };
}
