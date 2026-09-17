/**
 * SchemaClient — JS helper for running the proxy's saved requests and checking
 * what came back.
 *
 * The other three clients in this folder stage a condition; this one **asserts
 * an outcome**. A saved request can carry an expectation — an expected status,
 * a JSON Schema for the body, or both — and this runs it through the proxy and
 * tells you whether the response met it:
 *
 *   const { SchemaClient } = require("./schema-client");
 *   const client = new SchemaClient();
 *
 *   // Throws, listing every problem, if the response didn't match:
 *   await client.assertPasses("get-order");
 *
 *   // A whole collection, in order, one at a time:
 *   await client.assertCollectionPasses("checkout-flow");
 *
 *   // Or with a schema kept in *your* repo, next to this test:
 *   await client.assertPasses("get-order", {
 *     expect: { status: 200, schema: require("./schemas/order.json") },
 *   });
 *
 * **The schema is never evaluated here.** Every check is answered by the same
 * `utils/schema-validate.js` the dashboard uses, so this file cannot drift from
 * what the proxy actually enforces — the same reason `BlockClient` asks the
 * server whether a path is blocked instead of re-deriving the prefix rule.
 *
 * **A request with no expectation does not pass.** `assertPasses` throws on
 * one, because an assertion that checked nothing and returned green is the
 * failure this whole feature exists to prevent. Pass your own `expect`, or
 * construct with `{ requireCheck: false }` if you genuinely mean "just send
 * it".
 *
 * Standalone on purpose: zero dependencies (node:http only) so this file can be
 * copied into any QA repo. The port autodetection below intentionally
 * duplicates mock-client.js / capture-client.js / block-client.js /
 * scripts/cli.js — keeping the client droppable beats sharing.
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

/**
 * A failed expectation. Carries the errors as a list so a test runner can show
 * them one per line instead of one long string.
 */
class ExpectationFailed extends Error {
  constructor(label, errors) {
    super(`${label} failed its check:\n  ${errors.join("\n  ")}`);
    this.name = "ExpectationFailed";
    this.errors = errors;
  }
}

class SchemaClient {
  /**
   * @param {{ host?: string, port?: number, requireCheck?: boolean }} [opts] —
   *   explicit port skips autodetection (recommended in hermetic tests).
   *   Defaults honor the MOCK_HOST / MOCK_PORT environment variables.
   *   `requireCheck: false` lets `assertPasses` accept a request that checks
   *   nothing, instead of throwing to say the assertion was hollow.
   */
  constructor({ host, port, requireCheck = true } = {}) {
    this.host = host || process.env.MOCK_HOST || "localhost";
    this.port =
      port || (process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : null);
    this.requireCheck = requireCheck !== false;
  }

  async _resolvePort() {
    if (this.port) return this.port;
    for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + PORT_SCAN; p++) {
      if (await _probe(this.host, p)) return (this.port = p);
    }
    throw new Error(
      `SchemaClient: no mock proxy found on ${this.host}:${PREFERRED_PORT}-${
        PREFERRED_PORT + PORT_SCAN
      } (is the server running? set MOCK_PORT to override)`
    );
  }

  async _request(method, path, body) {
    const port = await this._resolvePort();
    const payload = body === undefined ? null : JSON.stringify(body);
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
      throw new Error(`SchemaClient: ${method} ${path} failed (${status}): ${msg}`);
    }
    return parsed;
  }

  /** Every saved request, newest first — id, name, path, and its `expect`. */
  async savedRequests() {
    return (await this._request("GET", "/saved-requests")).requests || [];
  }

  /** Every collection, ids already resolved into whole records. */
  async collections() {
    return (await this._request("GET", "/collections")).collections || [];
  }

  /**
   * Which saved requests actually check their response.
   *
   * Worth asking out loud before trusting a green run: a suite of requests that
   * assert nothing passes every time.
   *
   * @returns {Promise<Array<{id, name, path, checked: boolean, expect}>>}
   */
  async checks() {
    return (await this.savedRequests()).map((r) => ({
      id: r.id,
      name: r.name,
      method: r.method || "GET",
      path: r.path,
      checked: Boolean(r.expect),
      expect: r.expect || null,
    }));
  }

  /**
   * Send one saved request through the proxy and report what came back.
   *
   * Does **not** throw on a failed expectation — that is `assertPasses`. This
   * is for when you want the verdict as data.
   *
   * @param {string} id — a saved request id (see `checks()`)
   * @param {{expect?: object|null}} [opts] — `expect` **replaces** the stored
   *   expectation for this call, which is how you keep schemas in your own repo
   *   next to the tests that use them. `expect: null` sends without checking.
   * @returns {Promise<{status: number, checked: boolean, passed: boolean,
   *   errors: string[]}>}
   */
  async run(id, opts = {}) {
    const body = Object.hasOwn(opts, "expect") ? { expect: opts.expect } : {};
    const res = await this._request(
      "POST",
      `/saved-requests/${encodeURIComponent(id)}/send`,
      body
    );
    return {
      status: res.status,
      checked: Boolean(res.expect),
      // `passed` is only meaningful when something was checked; `checked` is
      // what tells the two apart, and callers must not conflate them.
      passed: res.expect ? res.expect.passed : false,
      errors: res.expect ? res.expect.errors : [],
    };
  }

  /**
   * Send one saved request and throw unless the response met its expectation.
   *
   * Throws `ExpectationFailed` (with `.errors`) when the check failed, and a
   * plain Error when the request **had no check at all** — see `requireCheck`.
   *
   * @returns {Promise<object>} the same result `run()` gives, on success
   */
  async assertPasses(id, opts = {}) {
    const result = await this.run(id, opts);
    if (!result.checked) {
      if (!this.requireCheck) return result;
      throw new Error(
        `SchemaClient: saved request "${id}" has no expectation, so this assertion ` +
          `checked nothing and would pass whatever came back. Add one from the ` +
          `dashboard's Expect tab, pass your own { expect: … }, or construct ` +
          `with { requireCheck: false } if sending without checking is intended.`
      );
    }
    if (!result.passed) throw new ExpectationFailed(`"${id}"`, result.errors);
    return result;
  }

  /**
   * Run a whole collection, **in order, one at a time**.
   *
   * Sequential and awaited because that is the shape these have — "log in, then
   * call the thing that needs the token". It does not stop at the first
   * failure: a run is how you find out *where* a flow breaks, and the results
   * after the red one are part of that answer.
   *
   * @param {string} nameOrId
   * @returns {Promise<Array<{id, name, status, checked, passed, errors}>>}
   */
  async runCollection(nameOrId) {
    const groups = await this.collections();
    const group = groups.find((g) => g.id === nameOrId || g.name === nameOrId);
    if (!group) {
      const known = groups.map((g) => g.id).join(", ") || "none";
      throw new Error(`SchemaClient: no collection "${nameOrId}". Known: ${known}`);
    }

    const results = [];
    for (const record of group.requests) {
      let outcome;
      try {
        outcome = await this.run(record.id);
      } catch (err) {
        // A request that could not be sent at all — SSL off for its target, its
        // instance gone, a stored schema that cannot be honoured. It belongs in
        // the results as a failure, not as a thrown exception that hides the
        // rows after it.
        outcome = { status: 0, checked: true, passed: false, errors: [err.message] };
      }
      results.push({ id: record.id, name: record.name, ...outcome });
    }
    return results;
  }

  /**
   * Run a collection and throw unless **every** request met its expectation.
   *
   * The message names each failure with its request, because "something in
   * checkout-flow broke" is not an answer anybody can act on.
   *
   * Unchecked requests are reported the same way `assertPasses` treats one:
   * they are not passes. Turn that off with `{ requireCheck: false }`.
   */
  async assertCollectionPasses(nameOrId) {
    const results = await this.runCollection(nameOrId);

    const problems = [];
    results.forEach((r) => {
      if (!r.checked) {
        if (this.requireCheck) problems.push(`${r.name}: nothing was checked`);
        return;
      }
      if (!r.passed) r.errors.forEach((line) => problems.push(`${r.name}: ${line}`));
    });

    if (problems.length)
      throw new ExpectationFailed(`Collection "${nameOrId}"`, problems);
    return results;
  }
}

module.exports = { SchemaClient, ExpectationFailed };
