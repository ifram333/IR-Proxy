/**
 * CaptureClient — JS helper for the mock proxy's capture-session API.
 *
 * Lets automated tests mark a START, exercise the app through the proxy,
 * mark an END, and assert on the exact requests the app sent in that window:
 *
 *   const { CaptureClient } = require("./capture-client");
 *   const client = new CaptureClient();
 *   await client.start({ name: "login-test" });
 *   // ... drive the app ...
 *   const { requests } = await client.stop();
 *   const login = requests.find((r) => r.path === "/api/login");
 *   expect(login.requestBody).toEqual({ user: "u", pass: "p" });
 *
 * Standalone on purpose: zero dependencies (node:http only) so this file can
 * be copied into any QA repo. The port autodetection below intentionally
 * duplicates scripts/cli.js — keeping the client droppable beats sharing.
 */
const http = require("http");

const PREFERRED_PORT = 8888; // proxy's preferred port (often already taken)
const PORT_SCAN = 20; // matches the proxy's own fallback scan range

/** Probe a port for OUR admin server (another proxy on 8888 won't match). */
function _probe(host, port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: host, port, path: "/__admin/health", method: "GET", timeout: 500 },
      (res) => {
        let data = "";
        res.on("data", (ch) => (data += ch));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            resolve(!!j && j.status === "ok" && Array.isArray(j.instances));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

class CaptureClient {
  /**
   * @param {{ host?: string, port?: number }} [opts] — explicit port skips
   *   autodetection (recommended in hermetic tests). Defaults honor the
   *   MOCK_HOST / MOCK_PORT environment variables.
   */
  constructor({ host, port } = {}) {
    this.host = host || process.env.MOCK_HOST || "localhost";
    this.port =
      port || (process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : null);
    this.sessionId = null;
  }

  async _resolvePort() {
    if (this.port) return this.port;
    for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + PORT_SCAN; p++) {
      if (await _probe(this.host, p)) return (this.port = p);
    }
    throw new Error(
      `CaptureClient: no mock proxy found on ${this.host}:${PREFERRED_PORT}-${
        PREFERRED_PORT + PORT_SCAN
      } (is the server running? set MOCK_PORT to override)`
    );
  }

  async _request(method, path, body) {
    const port = await this._resolvePort();
    const payload = body ? JSON.stringify(body) : null;
    const { status, data } = await new Promise((resolve, reject) => {
      const headers = { "Content-Type": "application/json" };
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const req = http.request(
        { hostname: this.host, port, path: `/__admin${path}`, method, headers },
        (res) => {
          let raw = "";
          res.on("data", (ch) => (raw += ch));
          res.on("end", () => resolve({ status: res.statusCode, data: raw }));
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }
    if (status < 200 || status >= 300) {
      const msg = (parsed && parsed.error) || data || `HTTP ${status}`;
      throw new Error(`CaptureClient: ${method} ${path} failed (${status}): ${msg}`);
    }
    return parsed;
  }

  /**
   * Start a capture session. The id is returned and remembered on the
   * instance, so subsequent calls may omit it.
   * @param {{ name?: string, instanceId?: string }} [opts] — instanceId
   *   restricts the capture to one configured backend instance.
   * @returns {Promise<string>} sessionId
   */
  async start({ name, instanceId } = {}) {
    const res = await this._request("POST", "/capture/start", { name, instanceId });
    this.sessionId = res.sessionId;
    return res.sessionId;
  }

  /**
   * Stop the session and return everything captured in the window.
   * Idempotent. Requests are chronological (oldest first).
   * @returns {Promise<{ sessionId, status, count, droppedCount, requests }>}
   */
  async stop(sessionId = this.sessionId) {
    if (!sessionId)
      throw new Error("CaptureClient: no active session (call start first)");
    return this._request("POST", "/capture/stop", { sessionId });
  }

  /**
   * Query a session's captured requests with optional filters:
   * method (exact, case-insensitive), path (exact pathname),
   * pathPrefix, instanceId, source ("mock"|"proxy"|"intercept"|"server-off").
   * @returns {Promise<object[]>}
   */
  async getRequests(sessionId = this.sessionId, filters = {}) {
    if (!sessionId)
      throw new Error("CaptureClient: no active session (call start first)");
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v !== undefined && v !== null)
    ).toString();
    const res = await this._request(
      "GET",
      `/capture/${encodeURIComponent(sessionId)}/requests${qs ? `?${qs}` : ""}`
    );
    return res.requests;
  }

  /** Session metadata (status, count, droppedCount) without the entries. */
  async getSession(sessionId = this.sessionId) {
    if (!sessionId)
      throw new Error("CaptureClient: no active session (call start first)");
    const res = await this._request("GET", `/capture/${encodeURIComponent(sessionId)}`);
    return res.session;
  }

  /** Delete a session server-side (e.g., in afterEach cleanup). */
  async delete(sessionId = this.sessionId) {
    if (!sessionId)
      throw new Error("CaptureClient: no active session (call start first)");
    await this._request("DELETE", `/capture/${encodeURIComponent(sessionId)}`);
    if (sessionId === this.sessionId) this.sessionId = null;
  }
}

module.exports = { CaptureClient };
