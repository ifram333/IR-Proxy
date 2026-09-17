/**
 * BlockClient — JS helper for the mock proxy's request-blocking API.
 *
 * A blocked path's connection is **destroyed rather than answered**: the client
 * sees a reset, which is what a service that is genuinely down looks like from
 * the outside. That is the reason this is worth driving from a test — turning a
 * mock on gives you any status you like, and the 503 switch gives you a 503,
 * but neither shows an app what happens when the network simply stops:
 *
 *   const { BlockClient } = require("./block-client");
 *   const client = new BlockClient();
 *   await client.block("api.example.com", "/orders");
 *   // ...the app's calls to /orders and everything under it now die...
 *   await client.unblock("api.example.com", "/orders");
 *
 *   // Or scoped to a block, restoring the host's prior rules afterwards:
 *   await client.withBlock({ host: "api.example.com", path: "/orders" },
 *     async () => { ...drive the app... });
 *
 * **A rule is a path prefix.** `/orders` kills `/orders` and `/orders/42`, and
 * pointedly not `/orders-archive`. Ask the server rather than guessing —
 * `isBlocked()` and `ruleFor()` are answered by the same code the proxy
 * enforces, so this file can never drift from it.
 *
 * **Blocking needs SSL on for the host.** The rule runs inside the decrypted
 * pipeline, so a tunneled host stores it and never fires it; every method here
 * that touches a host reports `ssl`, and `block()` throws when it is off rather
 * than leaving you with a rule that silently does nothing.
 *
 * Standalone on purpose: zero dependencies (node:http only) so this file can be
 * copied into any QA repo. The port autodetection below intentionally
 * duplicates mock-client.js / capture-client.js / scripts/cli.js — keeping the
 * client droppable beats sharing.
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

class BlockClient {
  /**
   * @param {{ host?: string, port?: number, requireSsl?: boolean }} [opts] —
   *   explicit port skips autodetection (recommended in hermetic tests).
   *   Defaults honor the MOCK_HOST / MOCK_PORT environment variables.
   *   `requireSsl: false` downgrades the "SSL is off for this host" guard on
   *   `block()` from a throw to a returned flag — for the rare suite that
   *   stages rules before turning interception on.
   */
  constructor({ host, port, requireSsl = true } = {}) {
    this.host = host || process.env.MOCK_HOST || "localhost";
    this.port =
      port || (process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : null);
    this.requireSsl = requireSsl !== false;
  }

  async _resolvePort() {
    if (this.port) return this.port;
    for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + PORT_SCAN; p++) {
      if (await _probe(this.host, p)) return (this.port = p);
    }
    throw new Error(
      `BlockClient: no mock proxy found on ${this.host}:${PREFERRED_PORT}-${
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
      throw new Error(`BlockClient: ${method} ${path} failed (${status}): ${msg}`);
    }
    return parsed;
  }

  /**
   * Kill every call to `path` **and everything under it** on `host`.
   *
   * Returns the host's resulting rules — the authoritative list, no second
   * round-trip. It may be shorter than you expect: a rule the new one now
   * covers is dropped, because a list of rules that decide nothing is a list
   * nobody trusts.
   *
   * @param {string} host — a hostname from the tree, e.g. "api.example.com"
   * @param {string} path — "/orders"; query and trailing slash are ignored
   * @returns {Promise<string[]>} the host's rules after the change
   * @throws when SSL proxying is off for the host (see `requireSsl`)
   */
  async block(host, path) {
    const res = await this._request("POST", "/hosts/block", {
      host,
      path,
      blocked: true,
    });
    if (this.requireSsl && res.ssl !== true) {
      // Not a warning: the caller is about to assert that requests die, and
      // they won't. Failing here names the reason; failing later names nothing.
      throw new Error(
        `BlockClient: SSL proxying is off for "${host}", so the rule is stored ` +
          `but never fires — the host is tunneled, not decrypted. Turn SSL on ` +
          `for it first (dashboard tree → right-click → SSL), or construct with ` +
          `{ requireSsl: false } if staging rules ahead of time is intended.`
      );
    }
    return res.blocks;
  }

  /**
   * Lift exactly this rule. Exact, not "whatever covers this path": a path
   * blocked by an ancestor stays blocked, and unblocking a child that silently
   * lifted its whole parent tree is not something anyone asks for. Use
   * `ruleFor()` to find the rule actually in play.
   *
   * Unblocking a path that was never a rule is a no-op, not an error.
   * @returns {Promise<string[]>} the host's rules after the change
   */
  async unblock(host, path) {
    const res = await this._request("POST", "/hosts/block", {
      host,
      path,
      blocked: false,
    });
    return res.blocks;
  }

  /**
   * A host's rules, or — with no host — every host that has any.
   * @param {string} [host]
   * @returns {Promise<string[] | Record<string, string[]>>}
   */
  async listBlocks(host) {
    if (host === undefined || host === null) {
      return (await this._request("GET", "/hosts/blocks")).blocks;
    }
    const res = await this._request(
      "GET",
      `/hosts/blocks?host=${encodeURIComponent(host)}`
    );
    return res.blocks;
  }

  /**
   * Which rule kills this path, or null. Answered server-side, by the same
   * `blockCovering` the proxy runs — so "would this die?" and "did this die?"
   * can never disagree.
   * @returns {Promise<string|null>}
   */
  async ruleFor(host, path) {
    const res = await this._request(
      "GET",
      `/hosts/blocks?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`
    );
    return res.rule;
  }

  /** Would a call to this path die? @returns {Promise<boolean>} */
  async isBlocked(host, path) {
    return (await this.ruleFor(host, path)) !== null;
  }

  /**
   * Whether the host is actually decrypted — i.e. whether a rule on it can
   * fire at all. Blocking is enforced inside the mock pipeline, and a tunneled
   * host never reaches it.
   * @returns {Promise<boolean>}
   */
  async isIntercepted(host) {
    const res = await this._request(
      "GET",
      `/hosts/blocks?host=${encodeURIComponent(host)}`
    );
    return res.ssl === true;
  }

  /** Lift every rule on a host (suite teardown). @returns {Promise<string[]>} */
  async clearBlocks(host) {
    let blocks = await this.listBlocks(host);
    for (const rule of blocks) blocks = await this.unblock(host, rule);
    return blocks;
  }

  /**
   * Block `path` for the duration of `fn`, then **restore the host's prior
   * rules**. Returns whatever `fn` resolves to; restoration runs even if it
   * throws.
   *
   * Restores the whole list rather than just lifting what it added, because
   * adding a rule can *remove* others — blocking `/orders` absorbs an existing
   * `/orders/42`, and an unblock alone would leave the host less blocked than
   * it started. Removals go first: re-adding a narrow rule while the broad one
   * is still in place is a no-op.
   *
   * @param {{ host: string, path: string }} opts
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  async withBlock({ host, path }, fn) {
    const before = await this.listBlocks(host);
    await this.block(host, path);
    try {
      return await fn();
    } finally {
      const after = await this.listBlocks(host);
      for (const rule of after.filter((r) => !before.includes(r))) {
        await this.unblock(host, rule);
      }
      for (const rule of before.filter((r) => !after.includes(r))) {
        await this.block(host, rule);
      }
    }
  }
}

module.exports = { BlockClient };
