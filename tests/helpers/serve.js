/**
 * One listening server per test file, instead of one per request.
 * ─────────────────────────────────────────────────────────────────────────────
 * Supertest, handed an Express **app**, binds a brand-new ephemeral port for
 * every single request:
 *
 *     serverAddress(app, path) {
 *       const addr = app.address();
 *       if (!addr) this._server = app.listen(0);   // ← per request
 *
 * Across this suite that is ~200 call sites and several hundred binds per run,
 * churning through the ephemeral range as fast as the kernel will recycle it.
 * Recycle a port while an earlier connection is still in flight and the request
 * arrives at whichever server now holds it — a server that has never heard of
 * the route being asked for. The symptom is a 404, a parse error, or an empty
 * list, in a different file on every run, always green on a retry:
 *
 *     ● request-log › ignores the Host header when it describes this server
 *       expected 200 "OK", got 404 "Not Found"
 *
 *   …from a three-line app whose only route is the one that 404'd. Nothing was
 *   wrong with the app; the request never reached it.
 *
 * Handed an **already-listening server**, supertest reuses its address instead.
 * So binding once per file — a couple of dozen ports per run rather than
 * hundreds — takes the collision probability to approximately zero without
 * touching a single assertion.
 *
 * Note this is not about jest workers: the failure reproduces under
 * `--runInBand`, in one process, which is what rules out every
 * cross-worker explanation and points here.
 *
 * @example
 *   // In beforeAll, once the app is fully wired:
 *   app = serve(app);          // every existing `request(app)` now reuses it
 *
 *   // Or inline, for an app built per test:
 *   await request(serve(app)).get("/thing").expect(200);
 */

"use strict";

const _servers = [];

/**
 * Bind `app` on an ephemeral port and return the listening server.
 *
 * Call it **after** the app is fully wired: what comes back is an
 * `http.Server`, not the Express app, so `.use()` on the result does nothing.
 */
function serve(app) {
  const server = app.listen(0);
  _servers.push(server);
  return server;
}

// Registered at import time, which puts it in the importing file's scope — so
// no test file has to remember to close anything. Jest reports an open handle
// for every server left listening, and a suite that leaks them drifts back into
// the same port pressure this exists to remove.
if (typeof afterAll === "function") {
  afterAll(async () => {
    await Promise.all(
      _servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve)))
    );
  });
}

module.exports = { serve };
