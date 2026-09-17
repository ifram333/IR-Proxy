/**
 * MockClient — JS helper for the mock proxy's mock-toggle API.
 *
 * Lets automated tests turn individual mocks ON or OFF for a given backend
 * instance, read back the resulting state, and (optionally) restore the prior
 * state after a block — so a suite can stage a scenario without touching the
 * dashboard:
 *
 *   const { MockClient } = require("./mock-client");
 *   const client = new MockClient();
 *   await client.setMock("api", "locked_user", true); // turn it ON
 *   // ... exercise the "blocked login" flow ...
 *   const state = await client.getState("api", "locked_user"); // true | false | null
 *
 *   // Or scoped to a block, auto-restoring the previous state afterwards:
 *   await client.withMock({ instanceId: "api", mockName: "locked_user", enabled: true },
 *     async () => { ...drive the app... });
 *
 * Standalone on purpose: zero dependencies (node:http only) so this file can be
 * copied into any QA repo. The port autodetection below intentionally
 * duplicates capture-client.js / scripts/cli.js — keeping the client droppable
 * beats sharing.
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

class MockClient {
  /**
   * @param {{ host?: string, port?: number }} [opts] — explicit port skips
   *   autodetection (recommended in hermetic tests). Defaults honor the
   *   MOCK_HOST / MOCK_PORT environment variables.
   */
  constructor({ host, port } = {}) {
    this.host = host || process.env.MOCK_HOST || "localhost";
    this.port =
      port || (process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : null);
  }

  async _resolvePort() {
    if (this.port) return this.port;
    for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + PORT_SCAN; p++) {
      if (await _probe(this.host, p)) return (this.port = p);
    }
    throw new Error(
      `MockClient: no mock proxy found on ${this.host}:${PREFERRED_PORT}-${
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
      throw new Error(`MockClient: ${method} ${path} failed (${status}): ${msg}`);
    }
    return parsed;
  }

  /**
   * Turn a single mock ON or OFF for an instance. Returns the server's
   * resulting state — the authoritative value, no second round-trip needed.
   * @param {string} instanceId — a configured backend id (e.g. "api")
   * @param {string} mockName — the mock's `name`
   * @param {boolean} enabled
   * @returns {Promise<{ instanceId: string, mockName: string, enabled: boolean }>}
   * @throws on 404 (unknown instance/mock) or 409 (mock not scoped to instance)
   */
  async setMock(instanceId, mockName, enabled) {
    const res = await this._request("POST", "/toggle", { instanceId, mockName, enabled });
    return { instanceId: res.instanceId, mockName: res.mockName, enabled: res.enabled };
  }

  /** Convenience: turn a mock ON. */
  enable(instanceId, mockName) {
    return this.setMock(instanceId, mockName, true);
  }

  /** Convenience: turn a mock OFF. */
  disable(instanceId, mockName) {
    return this.setMock(instanceId, mockName, false);
  }

  /**
   * Current toggle state of a single mock, as a TRI-STATE:
   *   true  → explicitly ON
   *   false → explicitly OFF
   *   null  → unset (no explicit toggle; the pipeline's default applies)
   * @returns {Promise<boolean|null>}
   */
  async getState(instanceId, mockName) {
    const states = (await this.getInstanceState(instanceId)).states || {};
    return Object.prototype.hasOwnProperty.call(states, mockName)
      ? states[mockName]
      : null;
  }

  /**
   * Bulk turn many mocks ON or OFF in one round-trip. Mocks that aren't scoped
   * to the instance are skipped server-side (not an error).
   * @param {string} instanceId
   * @param {string[]} mockNames
   * @param {boolean} enabled
   * @returns {Promise<{ enabled: boolean, count: number, mocks: string[] }>}
   */
  async setMocks(instanceId, mockNames, enabled) {
    const res = await this._request("POST", "/toggle-bulk", {
      instanceId,
      mockNames,
      enabled,
    });
    return { enabled: res.enabled, count: res.count, mocks: res.mocks };
  }

  /** All known mocks (name, file, folder, delay, servers) — for discovery. */
  async listMocks() {
    return (await this._request("GET", "/mocks")).mocks;
  }

  /**
   * Full state of an instance: { instanceId, isActive, targetUrl, latency,
   * summary: { on, off, unset }, states }.
   */
  async getInstanceState(instanceId) {
    return this._request("GET", `/state/${encodeURIComponent(instanceId)}`);
  }

  /**
   * Set a mock for the duration of `fn`, then RESTORE its prior tri-state.
   * Returns whatever `fn` resolves to. Restoration runs even if `fn` throws.
   * @param {{ instanceId: string, mockName: string, enabled: boolean }} opts
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  async withMock({ instanceId, mockName, enabled }, fn) {
    const prior = await this.getState(instanceId, mockName);
    await this.setMock(instanceId, mockName, enabled);
    try {
      return await fn();
    } finally {
      // prior === null means "unset"; the toggle API has no "unset", so the
      // closest faithful restore is leaving it at its pre-block boolean if one
      // existed, else turning it OFF (the pipeline default for an absent entry).
      await this.setMock(instanceId, mockName, prior === null ? false : prior);
    }
  }
}

module.exports = { MockClient };
