/**
 * In-memory request log with Server-Sent Events (SSE) broadcasting.
 * Stores the last MAX_LOG_SIZE requests and pushes new entries to all
 * connected SSE clients in real time.
 */

const sseHub = require("./sse-hub");
const { originalNames } = require("./header-case");
const { splitHostPort } = require("./interception");

/**
 * Read a positive integer from the environment, falling back to `fallback`.
 * Anything unparseable is ignored rather than obeyed — a typo in a shell profile
 * should not silently reconfigure how much traffic is retained.
 */
function _envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`⚠️  [Log] Ignoring ${name}="${raw}" — expected a positive integer.`);
    return fallback;
  }
  return value;
}

/**
 * How many entries are retained.
 *
 * Raising this is **not** free, and the cost is not mainly here: the hits table
 * renders from this log, so the real bill lands in the DOM long before it lands
 * in the heap — and the dashboard fetches all of them, bodies included, on load
 * (`MAX_CLIENT_ENTRIES` in `public/js/modules/entries.js` keeps the same
 * number). Lower it for long soak runs rather than raising it.
 */
const MAX_LOG_SIZE = _envInt("IR_PROXY_LOG_SIZE", 1000);

/**
 * Cap on each stored request/response body, so a handful of large payloads
 * can't grow the log unboundedly. Bodies over this are truncated and flagged
 * with `truncated: true`.
 *
 * The bill is `MAX_LOG_SIZE × 2 × MAX_BODY_CHARS` at worst — both bodies of
 * every entry at the cap — and it is close to linear. Measured on the real
 * proxy path, 1000 entries whose responses all exceed the cap:
 *
 *   | cap    | heap held | RSS    |
 *   | 128 KB |   127 MB  | 344 MB |
 *   | 256 KB |   252 MB  | 481 MB |
 *
 * That is the whole cost of doubling it. It only reads as linear because the
 * bodies are *detached* on truncation — see `_detach`; before that the log held
 * the full upstream response no matter what this was set to, so raising it
 * changed almost nothing and lowering it saved almost nothing.
 */
const MAX_BODY_CHARS = _envInt("IR_PROXY_BODY_CHARS", 256 * 1024);

let _log = [];
const _listeners = new Set();

// Logging can be switched off without stopping the proxy: mocks keep firing and
// traffic keeps flowing, nothing is retained. What you want before pushing a
// load test through it.
let _paused = false;

// Approximate bytes held by `_log`, tracked incrementally. Recomputing it would
// mean re-serialising every retained body, and the dashboard asks for it on a
// timer.
let _bytes = 0;

/**
 * How many **bytes** of a response are held while it is being captured.
 *
 * `MAX_BODY_CHARS` counts UTF-16 code units, and UTF-8 spends at most three
 * bytes per unit, so this is always enough to overshoot the character cap —
 * which is what keeps `truncated` tripping — while bounding what a large
 * response costs to look at. Without a bound here the proxy path buffers the
 * whole thing: `responseInterceptor` hands the body over as a **single** chunk,
 * so the per-chunk cap below never got a chance to stop anything, and a 200 MB
 * download was mirrored into memory in full before being cut to the cap.
 */
const MAX_CAPTURE_BYTES = 3 * MAX_BODY_CHARS + 3;

/**
 * Copy a string out of whatever it was sliced from.
 *
 * `str.slice(…)` in V8 is a *view* onto its parent — the parent stays alive for
 * as long as the view does. So truncating a body to the cap retained the entire
 * original: measured on the real proxy path, 1000 × 512 KB responses cost
 * 500 MB of heap while `stats()` honestly reported 125 MB, because the number it
 * tracks is what was stored and the leak was in what was still *referenced*.
 * The round-trip through a Buffer is the copy that lets the original go.
 *
 * A truncation can land inside a surrogate pair, and the pair's lone half comes
 * back as U+FFFD rather than an unpaired surrogate. That is a better broken
 * character than the one it replaces, and it only ever affects the last glyph of
 * an already-cut body.
 */
const _detach = (str) => Buffer.from(str, "utf8").toString("utf8");

/**
 * Truncate a body value to MAX_BODY_CHARS. Objects are serialized for the size
 * check and, when oversized, stored as a truncated string.
 *
 * `length` comes back with it so the size accounting below is free — this is the
 * one place the body is already being measured.
 *
 * @returns {{ value: *, truncated: boolean, length: number }}
 */
function _capBody(value) {
  if (value == null) return { value, truncated: false, length: 0 };
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str == null) return { value, truncated: false, length: 0 };
  if (str.length <= MAX_BODY_CHARS) {
    return { value, truncated: false, length: str.length };
  }
  return {
    value: _detach(str.slice(0, MAX_BODY_CHARS)) + "…[truncated]",
    truncated: true,
    length: MAX_BODY_CHARS,
  };
}

/** Rough per-record cost beyond the bodies: ids, timestamps, path, the object. */
const RECORD_OVERHEAD = 512;

/** `originalNames`, or `undefined` when every name was already lowercase. */
const _headerCase = (rawHeaders) => {
  const names = originalNames(rawHeaders);
  return Object.keys(names).length ? names : undefined;
};

const _headerBytes = (headers) => {
  try {
    return headers ? JSON.stringify(headers).length : 0;
  } catch {
    return 0;
  }
};

/**
 * Add a new log entry and broadcast it to all SSE subscribers.
 * @param {object} entry - { instanceId, host, port, protocol, durationMs, method,
 *   path, status, source, delay, requestHeaders, requestHeaderCase,
 *   requestBody, responseHeaders, responseBody }
 */
function addEntry(entry) {
  // Paused means paused: nothing retained, nothing broadcast, no listeners run.
  // Traffic still flows and mocks still fire — this only stops the recording.
  if (_paused) return null;

  const reqCap = _capBody(entry.requestBody);
  const resCap = _capBody(entry.responseBody);
  // Records are immutable after creation by convention: SSE payloads, entry
  // listeners, and capture sessions all share references to this object.
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry,
    requestBody: reqCap.value,
    responseBody: resCap.value,
    truncated: reqCap.truncated || resCap.truncated || undefined,
    // Granular flags: replay needs to know specifically whether the *request*
    // body is incomplete (replaying a cut body would be misleading).
    requestTruncated: reqCap.truncated || undefined,
    responseTruncated: resCap.truncated || undefined,
  };

  // Non-enumerable: this is bookkeeping, and every record is JSON-serialised
  // straight onto the SSE stream and into capture sessions.
  Object.defineProperty(record, "__bytes", {
    value:
      reqCap.length +
      resCap.length +
      _headerBytes(entry.requestHeaders) +
      _headerBytes(entry.requestHeaderCase) +
      _headerBytes(entry.responseHeaders) +
      RECORD_OVERHEAD,
    enumerable: false,
  });

  _log.unshift(record);
  _bytes += record.__bytes;
  while (_log.length > MAX_LOG_SIZE) {
    _bytes -= _log.pop().__bytes || 0;
  }

  // Unnamed frame: EventSource routes it to `onmessage`, which is where the
  // dashboard's log stream listens. Named channels (e.g. "host") are separate.
  sseHub.broadcast(null, record);

  for (const fn of _listeners) {
    try {
      fn(record);
    } catch (_) {
      // A listener must never break request logging.
    }
  }

  return record;
}

/**
 * Subscribe to every new log entry (e.g., capture sessions).
 * @param {(record: object) => void} fn
 * @returns {() => void} unsubscribe function
 */
function onEntry(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Work out which host this request was actually addressed to.
 *
 * The MITM tunnel stashes the CONNECT target on the TLS socket, which is the
 * only fully reliable source. The Host header is next-best and correct for
 * plain-HTTP proxying (absolute-form requests carry the real origin), but it
 * reads `localhost:3000` on the standalone per-instance servers — those pass
 * `trustHostHeader: false` and fall through to the configured target instead.
 *
 * @returns {{host: string|null, port: number|null, protocol: string}}
 */
function _resolveOrigin(req, fallbackTarget, trustHostHeader) {
  const socket = req.socket || {};
  const protocol = socket.encrypted ? "https" : "http";

  if (socket.__irProxyHost) {
    return { host: socket.__irProxyHost, port: socket.__irProxyPort || null, protocol };
  }

  const headerHost = trustHostHeader && req.headers && req.headers.host;
  if (headerHost) {
    // Shared with the CONNECT parser so IPv6 literals are handled identically.
    const { hostname, port } = splitHostPort(headerHost);
    if (hostname) return { host: hostname, port, protocol };
  }

  try {
    const url = new URL(fallbackTarget);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : null,
      protocol: url.protocol === "https:" ? "https" : "http",
    };
  } catch {
    return { host: null, port: null, protocol };
  }
}

/**
 * Express middleware that intercepts and logs full request and response details.
 *
 * @param {string} instanceId
 * @param {object} [opts]
 * @param {() => string} [opts.targetUrl] resolves the instance's upstream URL,
 *   used as the fallback for the host/port/protocol fields.
 * @param {boolean} [opts.trustHostHeader=true] set false where the Host header
 *   describes this server rather than the origin (the standalone tier).
 */
function createLoggerMiddleware(instanceId, opts) {
  const resolveTarget = (opts && opts.targetUrl) || (() => null);
  const trustHostHeader = !opts || opts.trustHostHeader !== false;

  return (req, res, next) => {
    // Skip admin endpoints and static files
    const isStatic = /\.(css|js|html|png|jpg|jpeg|gif|ico|svg|pem|cer)$/i.test(req.path);
    if (req.path.startsWith("/__admin") || req.path === "/" || isStatic) {
      return next();
    }

    const startedAt = process.hrtime.bigint();
    const chunks = [];
    let chunkBytes = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;

    // Buffer the response body for logging, but stop retaining once we hit the
    // cap so a large download isn't mirrored into memory in full. The client
    // still receives every chunk via the original write/end below.
    //
    // The chunk is **clipped**, not just refused: on the proxy path the whole
    // body arrives as one chunk, so a rule that only decides whether to take the
    // next one never declined anything. `chunkBytes` still counts what really
    // came through, so the entry is flagged truncated on the real size.
    const captureChunk = (chunk) => {
      if (!chunk || chunkBytes >= MAX_CAPTURE_BYTES) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = MAX_CAPTURE_BYTES - chunkBytes;
      // `subarray` is a view on the incoming chunk, which is the client's to
      // free — copy out of it rather than pinning the whole thing.
      chunks.push(buf.length > room ? Buffer.from(buf.subarray(0, room)) : buf);
      chunkBytes += buf.length;
    };

    res.write = function (chunk, ...args) {
      captureChunk(chunk);
      return originalWrite.apply(res, [chunk, ...args]);
    };

    /**
     * Build and store the entry. Split out of `res.end` so a request that is
     * **killed** rather than answered still reaches the log: blocking destroys
     * the socket, `res.end` never runs, and the one request you most want to
     * see would otherwise be the one that vanishes.
     *
     * Guarded, because a killed request can still fire both paths.
     */
    let recorded = false;
    const record = (statusOverride) => {
      if (recorded) return;
      recorded = true;

      // Capture request body (Express body parsers populate req.body)
      let reqBody = req.body;
      if (
        reqBody &&
        typeof reqBody === "object" &&
        Object.keys(reqBody).length === 0 &&
        req.headers["content-length"] === "0"
      ) {
        reqBody = null;
      }

      // Capture response body
      let resBody = null;
      try {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        if (rawBody) {
          try {
            resBody = JSON.parse(rawBody);
          } catch {
            resBody = rawBody;
          }
        }
      } catch (err) {
        console.error("Error parsing response body for log:", err);
      }

      const origin = _resolveOrigin(req, resolveTarget(), trustHostHeader);

      // Add log entry
      addEntry({
        instanceId,
        host: origin.host,
        port: origin.port,
        protocol: origin.protocol,
        // Wall-clock time the client experienced, mock delay and simulated
        // instance latency included — that's the number worth showing.
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100,
        method: req.method,
        path: req.originalUrl || req.url,
        // 0 for a killed request: there was no response, and the tree and the
        // hits table already read 0 as a failure alongside 4xx/5xx.
        status: statusOverride === undefined ? res.statusCode : statusOverride,
        source: req.logSource || "proxy",
        mockName: req.logMockName || null,
        delay: req.logDelay || 0,
        // Two flags rather than one "synthetic": while reading the log, "I
        // re-sent something that really happened" and "I made this up" are
        // different claims, and the second is the one that explains a request
        // no device ever made.
        replayed: req.headers["x-ir-proxy-replayed"] === "1" || undefined,
        composed: req.headers["x-ir-proxy-composed"] === "1" || undefined,
        transformError: req.logTransformError || undefined,
        requestHeaders: req.headers,
        // The same names as `requestHeaders`, spelled the way the client
        // actually sent them — and **only** the ones that differ, so ordinary
        // browser traffic costs nothing. `requestHeaders` stays lowercase on
        // purpose: it is Node's parse, it is what every mock matches on, and it
        // is what the capture clients are documented to read. The inspector
        // renders through this so what you see is what went out.
        requestHeaderCase: _headerCase(req.rawHeaders),
        requestBody: reqBody,
        responseHeaders: res.getHeaders(),
        responseBody: resBody,
      });
    };

    res.end = function (chunk, ...args) {
      captureChunk(chunk);
      // Terminate first, then log: the client should not wait on bookkeeping.
      const result = originalEnd.apply(res, [chunk, ...args]);
      record();
      return result;
    };

    /**
     * Record a request that is about to be killed, with no response at all.
     *
     * Installed on `res` rather than exported, so the caller doing the killing
     * needs none of this middleware's configuration — the host/protocol
     * resolution it would have to duplicate is exactly the fiddly part
     * (`_resolveOrigin`).
     *
     * @param {number} [status] defaults to 0, "never answered"
     */
    res.logAbort = (status = 0) => record(status);

    next();
  };
}

/** Return the most recent `limit` log entries. */
function getHistory(limit = 100) {
  return _log.slice(0, Math.min(limit, MAX_LOG_SIZE));
}

/** Look up a single stored entry by id (used by replay). */
function getEntry(id) {
  return _log.find((e) => e.id === id) || null;
}

/**
 * Clear stored log entries.
 *
 * With no filter this wipes everything (the long-standing behaviour the CLI and
 * the dashboard's "Clear" button rely on). Pass `{ host }` or `{ instanceId }`
 * to clear only one host's traffic — that's the per-host "Clear log" action.
 *
 * @param {{host?: string, instanceId?: string}} [filter]
 * @returns {number} how many entries were removed
 */
function clearLog(filter) {
  const { host, instanceId } = filter || {};
  if (!host && !instanceId) {
    const removed = _log.length;
    _log = [];
    _bytes = 0;
    return removed;
  }

  const before = _log.length;
  _log = _log.filter((e) => {
    const drop = (host && e.host === host) || (instanceId && e.instanceId === instanceId);
    if (drop) _bytes -= e.__bytes || 0;
    return !drop;
  });
  // Floating-point drift is impossible here (integers only), but a record that
  // predates the accounting would leave a phantom balance behind.
  if (_log.length === 0) _bytes = 0;
  return before - _log.length;
}

/**
 * What the log currently costs, and the limits it is working to.
 *
 * `bytes` is an **estimate**: the retained bodies and headers plus a flat
 * per-record allowance. It tracks the shape of the real cost — which is what you
 * want when deciding whether to clear or pause — without re-serialising a
 * thousand records every time the dashboard asks.
 */
function stats() {
  return {
    entries: _log.length,
    bytes: _bytes,
    maxEntries: MAX_LOG_SIZE,
    maxBodyChars: MAX_BODY_CHARS,
    paused: _paused,
  };
}

/**
 * Stop or resume recording, without touching the proxy.
 * @returns {boolean} the new state
 */
function setPaused(paused) {
  _paused = Boolean(paused);
  return _paused;
}

function isPaused() {
  return _paused;
}

/**
 * Carry already-logged entries over to an instance's new id.
 *
 * Entries are immutable snapshots of a request, but `instanceId` is a live
 * reference, not part of the snapshot: it is what the per-host "Clear log" and
 * the capture filters match on. Leaving the old value behind makes the
 * already-captured traffic invisible to both.
 *
 * @returns {number} how many entries were updated
 */
function renameInstance(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return 0;
  let updated = 0;
  _log.forEach((entry) => {
    if (entry.instanceId !== oldId) return;
    entry.instanceId = newId;
    updated++;
  });
  return updated;
}

/**
 * Register an SSE response object. Automatically removes it when the
 * client disconnects.
 * @param {import('express').Response} res
 */
function addSSEClient(res) {
  sseHub.addClient(res);
}

module.exports = {
  MAX_LOG_SIZE,
  MAX_BODY_CHARS,
  addEntry,
  createLoggerMiddleware,
  getHistory,
  getEntry,
  clearLog,
  renameInstance,
  stats,
  setPaused,
  isPaused,
  addSSEClient,
  onEntry,
};
