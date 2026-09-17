/**
 * mock-pipeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts the mock interceptor + proxy middleware from server.js into a
 * reusable factory. Used by both the per-instance Express servers AND the
 * unified proxy server for consistent mock behaviour.
 */

const {
  createProxyMiddleware,
  fixRequestBody,
  responseInterceptor,
} = require("http-proxy-middleware");

const loadMocks = require("./mock-loader");
const { isBlocked, BLOCKED_SOURCE } = require("./blocking");
const { originalNames } = require("./header-case");
const { writeRawBody } = require("./body-capture");

// Upstream requests that exceed this are aborted and answered with 502 so a
// dead backend can't hold client sockets open indefinitely.
const PROXY_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates the middleware that kills requests to blocked paths.
 *
 * **Before the mocks, and before the 503 switch**, because a block is not a
 * response — it is the connection going away, and a mock answering first would
 * make the service look alive. It is also the more specific instruction: you
 * blocked *this path*, not the whole instance.
 *
 * The host comes from the instance's configured target rather than the request,
 * because on the standalone tier the `Host` header reads `localhost:3001` and
 * every rule would silently stop matching there.
 *
 * @param {object} store        - Shared in-memory state store
 * @param {() => string|null} resolveHost - the intercepted host these rules belong to
 * @returns {import('express').RequestHandler}
 */
function createBlockMiddleware(store, resolveHost) {
  return (req, res, next) => {
    if (req.url.startsWith("/__admin")) return next();

    const host = resolveHost();
    const blocks = host ? store.hostSettings?.[host]?.blocks : null;
    if (!blocks?.length || !isBlocked(req.path, blocks)) return next();

    req.logSource = BLOCKED_SOURCE;
    // Log it before the socket goes, or the request disappears entirely — and
    // "did my block fire?" is the whole question. Optional call: the pipeline
    // is also mounted in tests without the logger in front of it.
    res.logAbort?.(0);
    // Destroy rather than respond. A 503 is something a client can read; this
    // is meant to look like the service is simply not there.
    req.socket?.destroy();
  };
}

/**
 * Creates the mock interceptor middleware for a given instance.
 *
 * @param {string} instanceId
 * @param {object} store       - Shared in-memory state store
 * @param {string} MOCKS_DIR   - Absolute path to the mocks directory
 * @returns {import('express').RequestHandler}
 */
function createMockMiddleware(instanceId, store, MOCKS_DIR) {
  return (req, res, next) => {
    if (req.url.startsWith("/__admin")) return next();

    if (!store.instanceSettings[instanceId]?.isActive) {
      req.logSource = "server-off";
      return res.status(503).send("Server Off");
    }

    const mockRegistry = loadMocks(MOCKS_DIR);
    // A mock applies to this instance only if it is unscoped (no `servers`
    // field) or explicitly lists this instance id.
    const inScope = (m) => !m.servers || m.servers.includes(instanceId);
    const activeMock = mockRegistry.find(
      (m) =>
        inScope(m) && m.match(req) && store.instanceStatus[instanceId]?.[m.name] === true
    );

    if (activeMock) {
      if (activeMock.interceptResponse) {
        req.activeInterceptMock = activeMock;
        req.logSource = "intercept";
        req.logMockName = activeMock.name;
        return next();
      }
      // Instance-wide simulated latency stacks on top of the mock's own delay.
      const latency = store.instanceSettings[instanceId]?.latency || 0;
      const delay = (activeMock.delay || 0) + latency;
      const respond = () => {
        req.logSource = "mock";
        req.logMockName = activeMock.name;
        req.logDelay = delay;
        activeMock.respond(req, res);
      };
      return delay > 0 ? setTimeout(respond, delay) : respond();
    }

    next();
  };
}

/**
 * Put the header names back the way the client wrote them.
 *
 * Node's HTTP parser lowercases every field name into `req.headers`, and
 * `http-proxy` builds the upstream request from exactly that map — so a device
 * (or a composed request) that sends `tokenId` has it forwarded as `tokenid`.
 * Field names are case-insensitive per RFC 9110 and a correct backend does not
 * care, but plenty of real ones do, and a debugging proxy that quietly rewrites
 * what it is showing you makes itself the variable in the bug you came here to
 * find. `req.rawHeaders` is the wire truth, so the names are restored from it.
 *
 * Only names that actually differ are touched (`header-case.js` owns that rule,
 * shared with the activity log), and only if the header survived into the
 * outbound request — `host` is rewritten by `changeOrigin`, and the value that
 * goes out is always the proxy's, never the one off the wire.
 *
 * Must run **before** `fixRequestBody`: that writes the body, which flushes the
 * header block, after which `setHeader` throws.
 */
function restoreHeaderCase(proxyReq, req) {
  for (const [lower, name] of Object.entries(originalNames(req.rawHeaders))) {
    if (!proxyReq.hasHeader(lower)) continue;
    const value = proxyReq.getHeader(lower);
    proxyReq.removeHeader(lower);
    proxyReq.setHeader(name, value);
  }
}

/**
 * Creates the http-proxy-middleware handler for a given instance.
 *
 * @param {string} instanceId
 * @param {object} store       - Shared in-memory state store
 * @returns {import('express').RequestHandler}
 */
function createProxyHandler(instanceId, store) {
  return createProxyMiddleware({
    router: () => store.instanceSettings[instanceId].targetUrl,
    changeOrigin: true,
    selfHandleResponse: true,
    pathFilter: (p) => !p.startsWith("/__admin") && !p.includes("index.html"),
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    on: {
      proxyReq: (proxyReq, req) => {
        restoreHeaderCase(proxyReq, req);
        // The raw bytes when we have them; `fixRequestBody`'s re-serialisation
        // only as the fallback, for a body some other parser consumed.
        if (!writeRawBody(proxyReq, req)) fixRequestBody(proxyReq, req);
      },
      // responseInterceptor hands us the body already decompressed (it
      // gunzips gzip/br/deflate itself and drops the content-encoding header).
      proxyRes: responseInterceptor(async (buf, proxyRes, req) => {
        req.logSource = req.activeInterceptMock ? "intercept" : "proxy";
        req.logMockName = req.activeInterceptMock?.name;

        // Instance-wide simulated latency also applies to proxied responses.
        const latency = store.instanceSettings[instanceId]?.latency || 0;
        if (latency > 0) {
          req.logDelay = latency;
          await sleep(latency);
        }

        const transform = req.activeInterceptMock?.transform;
        // Without a transform, pass the bytes through untouched — converting
        // to a UTF-8 string would corrupt binary payloads (images, fonts…).
        if (!transform) return buf;

        // Transforms only make sense on JSON payloads; anything else passes
        // through so we never mangle it.
        const contentType = proxyRes.headers["content-type"] || "";
        if (!contentType.includes("json")) {
          req.logTransformError = `transform skipped: content-type "${contentType}" is not JSON`;
          console.warn(`⚠️  [${instanceId}] ${req.logTransformError} (${req.path})`);
          return buf;
        }

        try {
          return JSON.stringify(transform(JSON.parse(buf.toString("utf8")), req));
        } catch (e) {
          // Serve the real response rather than failing the request, but
          // surface the error in the activity log instead of only stderr.
          req.logTransformError = e.message;
          console.error(`⚠️  [${instanceId}] Transform error on ${req.path}:`, e.message);
          return buf;
        }
      }),
      error: (err, req, res) => {
        console.error(`🔴 [${instanceId}] Proxy error on ${req.url}: ${err.message}`);
        req.logSource = "proxy";
        if (res && typeof res.status === "function" && !res.headersSent) {
          res
            .status(502)
            .json({ error: "Upstream request failed", code: err.code || "EPROXY" });
        } else if (res && typeof res.end === "function") {
          res.end();
        }
      },
    },
  });
}

module.exports = {
  createBlockMiddleware,
  createMockMiddleware,
  createProxyHandler,
};
