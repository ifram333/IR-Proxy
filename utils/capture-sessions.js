/**
 * Capture sessions for automated tests.
 *
 * A test marks a START, exercises the app through the proxy, marks an END,
 * and then reads back every request logged in that window so it can assert
 * the exact payloads the app sent.
 *
 * Module-level singleton (same pattern as request-log): createAdminRouter is
 * instantiated once per instance app plus once for the dashboard, and every
 * router must see the same sessions.
 *
 * Sessions accumulate entries at addEntry time (via requestLog.onEntry), not
 * by filtering the rolling log afterwards — the 100-entry log cap must never
 * silently drop entries from an active capture window. Stored entries are
 * shared references to the immutable log records.
 *
 * Sessions are in-memory only and never persisted to state.json.
 */
const requestLog = require("./request-log");

// Beyond this, entries are counted in droppedCount instead of stored.
const MAX_ENTRIES_PER_SESSION = 1000;
// Stopped/expired sessions beyond this are evicted oldest-first.
const MAX_FINISHED_SESSIONS = 25;
// Hard cap on concurrently active sessions; startSession throws past it
// (a loud error beats silently corrupting a parallel test run).
const MAX_ACTIVE_SESSIONS = 25;
// Active sessions abandoned past this lazily flip to "expired" (entries are
// kept; they just stop accumulating). No timers: swept on every public call.
const ACTIVE_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, object>} insertion-ordered; eviction walks oldest first */
const _sessions = new Map();

function _sweep() {
  const now = Date.now();
  for (const session of _sessions.values()) {
    if (session.status === "active" && now - session.startedAtMs > ACTIVE_TTL_MS) {
      session.status = "expired";
      session.stoppedAt = new Date().toISOString();
    }
  }
  _evictFinished();
}

function _evictFinished() {
  let finished = 0;
  for (const session of _sessions.values()) {
    if (session.status !== "active") finished++;
  }
  if (finished <= MAX_FINISHED_SESSIONS) return;
  for (const [id, session] of _sessions) {
    if (session.status === "active") continue;
    _sessions.delete(id);
    if (--finished <= MAX_FINISHED_SESSIONS) return;
  }
}

function _handleEntry(record) {
  _sweep();
  for (const session of _sessions.values()) {
    if (session.status !== "active") continue;
    if (session.filter.instanceId && record.instanceId !== session.filter.instanceId) {
      continue;
    }
    if (session.entries.length < MAX_ENTRIES_PER_SESSION) {
      session.entries.push(record);
    } else {
      session.droppedCount++;
    }
  }
}

requestLog.onEntry(_handleEntry);

function _meta(session) {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    filter: session.filter,
    count: session.entries.length,
    droppedCount: session.droppedCount,
  };
}

/**
 * Start a new capture session.
 * @param {{ name?: string, instanceId?: string }} [opts]
 * @returns {object} session metadata
 * @throws {Error} err.code === "CAPACITY" when MAX_ACTIVE_SESSIONS is reached
 */
function startSession({ name, instanceId } = {}) {
  _sweep();
  let active = 0;
  for (const session of _sessions.values()) {
    if (session.status === "active") active++;
  }
  if (active >= MAX_ACTIVE_SESSIONS) {
    const err = new Error(
      `Too many active capture sessions (max ${MAX_ACTIVE_SESSIONS}) — stop or delete old sessions`
    );
    err.code = "CAPACITY";
    throw err;
  }
  const now = Date.now();
  const session = {
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    name: name || null,
    status: "active",
    startedAt: new Date(now).toISOString(),
    startedAtMs: now,
    stoppedAt: null,
    filter: { instanceId: instanceId || null },
    entries: [],
    droppedCount: 0,
  };
  _sessions.set(session.id, session);
  return _meta(session);
}

/**
 * Stop a session. Idempotent: stopping an already-stopped/expired session
 * returns its current data unchanged.
 * @returns {object|null} session (with entries) or null if unknown
 */
function stopSession(id) {
  _sweep();
  const session = _sessions.get(id);
  if (!session) return null;
  if (session.status === "active") {
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    _evictFinished();
  }
  return session;
}

/** @returns {object|null} full session (with entries) or null */
function getSession(id) {
  _sweep();
  return _sessions.get(id) || null;
}

/**
 * Entries of a session, optionally filtered. Chronological (oldest first).
 * `path` matches the pathname exactly (entry.path may carry a query string);
 * `pathPrefix` matches the start of the full stored path.
 * @returns {object[]|null} null if the session is unknown
 */
function getRequests(id, { method, path, pathPrefix, instanceId, source } = {}) {
  _sweep();
  const session = _sessions.get(id);
  if (!session) return null;
  return session.entries.filter((entry) => {
    if (method && (entry.method || "").toUpperCase() !== method.toUpperCase())
      return false;
    if (path && (entry.path || "").split("?")[0] !== path) return false;
    if (pathPrefix && !(entry.path || "").startsWith(pathPrefix)) return false;
    if (instanceId && entry.instanceId !== instanceId) return false;
    if (source && entry.source !== source) return false;
    return true;
  });
}

/** @returns {object[]} metadata of every session (no entries) */
function listSessions() {
  _sweep();
  return [..._sessions.values()].map(_meta);
}

/** @returns {boolean} true if the session existed */
function deleteSession(id) {
  _sweep();
  return _sessions.delete(id);
}

/**
 * Follow an instance through a rename, in both the session filters and the
 * entries already captured.
 *
 * A session started against `api` is scoped to that instance for its whole
 * life; if the rename only moved the store slices, an active session would
 * quietly stop matching the very traffic it was opened to record — and an
 * automated test asserting on it would fail for no visible reason.
 *
 * @returns {number} how many sessions were touched
 */
function renameInstance(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return 0;
  let touched = 0;
  for (const session of _sessions.values()) {
    let changed = false;
    if (session.filter.instanceId === oldId) {
      session.filter.instanceId = newId;
      changed = true;
    }
    session.entries.forEach((entry) => {
      if (entry.instanceId !== oldId) return;
      entry.instanceId = newId;
      changed = true;
    });
    if (changed) touched++;
  }
  return touched;
}

/** Test hygiene, like requestLog.clearLog(). */
function clearAll() {
  _sessions.clear();
}

module.exports = {
  startSession,
  stopSession,
  getSession,
  getRequests,
  listSessions,
  deleteSession,
  renameInstance,
  clearAll,
  sessionMeta: _meta,
  MAX_ENTRIES_PER_SESSION,
  MAX_FINISHED_SESSIONS,
  MAX_ACTIVE_SESSIONS,
  ACTIVE_TTL_MS,
};
