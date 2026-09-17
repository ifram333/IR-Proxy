/**
 * Sending a request through the full pipeline, and the requests saved for it.
 *
 * `/replay` re-sends something a device already did; `/send` sends one composed
 * from scratch. Both go through `sendViaProxy`, which is where the guarantees live:
 * the target host comes from the instance and cannot be set by the caller, and the
 * origin flag is re-forced so it cannot be forged. `/saved-requests` validates with
 * the same rules, so nothing unsendable can be stored.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const http = require("http");
const requestLog = require("../request-log");
const instanceManager = require("../instance-manager");
const requestStore = require("../request-store");
const collectionStore = require("../collection-store");
const schemaValidate = require("../schema-validate");
const template = require("../template");
const headerCase = require("../header-case");
const { encodeForm } = require("../form-encode");

module.exports = function registerSend(router, ctx) {
  const { store, serverConfigs } = ctx;

  // ── Sending a request through the full pipeline ───────────────────────────
  // Two routes end up here: `/replay` re-sends something a device already did,
  // `/send` sends one composed from scratch in the dashboard. Both loop the
  // request back through the proxy in absolute form, exactly like a device
  // would send it — handlePlainHTTP routes it into the cached instance pipeline
  // (logger → mocks → proxy), so the result shows up in the activity log (and
  // SSE stream) on its own, flagged.
  //
  // The point of going the long way round instead of calling the upstream
  // directly: the request meets the same mocks, latency and 503 switch a device
  // would, which is the whole reason for composing it here rather than in
  // Postman.
  //
  // The target host is deliberately NOT something the caller can set. It is
  // derived from the instance, which is what keeps the mock pipeline and the
  // log entry coherent — for a replay, the instance that captured it.

  const SENDABLE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

  /**
   * How much response body will be held in order to check it.
   *
   * Deliberately larger than the activity log's `IR_PROXY_BODY_CHARS`: the log
   * keeps an excerpt to *read*, this holds a body to *parse*, and half a JSON
   * document does not parse. Past the cap the expectation reports that it
   * could not be checked — which is the honest answer, and the same call the
   * replay route makes when the log truncated a request body.
   */
  const MAX_VALIDATE_BYTES = 1024 * 1024;

  /**
   * Validate an `expect` block — what the caller says a good response looks
   * like. Both halves are optional and independent: a status alone is a
   * perfectly good expectation, and so is a schema alone.
   *
   * Runs on send *and* on save, exactly like `validateRequestFields`, so a
   * schema this validator cannot honour is refused while you are still looking
   * at it rather than passing quietly forever after.
   *
   * @throws {Error} with a message safe to return as a 400
   * @returns {{status?: number, schema?: object}|null} null when none was asked for
   */
  const validateExpect = (expect) => {
    if (expect == null) return null;
    if (typeof expect !== "object" || Array.isArray(expect)) {
      throw new Error("expect must be an object");
    }

    const out = {};

    if (expect.status != null) {
      const status = Number(expect.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error("expect.status must be an HTTP status code (100-599)");
      }
      out.status = status;
    }

    if (expect.schema != null) {
      // Throws with `.status = 400` and a message naming the keyword.
      schemaValidate.assertSupported(expect.schema);
      out.schema = expect.schema;
    }

    // An empty `{}` expects nothing, which is the same as not asking — say so
    // rather than reporting a pass that checked nothing.
    return out.status === undefined && out.schema === undefined ? null : out;
  };

  /**
   * Hold the response up against the expectation.
   *
   * Every check accumulates: a run is how you find out what is wrong with a
   * response, and stopping at the status would hide the schema errors behind
   * it for another round trip.
   *
   * @returns {{passed: boolean, errors: string[]}}
   */
  const checkExpectation = (expect, { status, contentType, body, truncated }) => {
    const errors = [];

    if (expect.status !== undefined && status !== expect.status) {
      errors.push(`expected status ${expect.status}, got ${status}`);
    }

    if (expect.schema) {
      if (truncated) {
        errors.push(
          `response body is over ${Math.floor(MAX_VALIDATE_BYTES / 1024)} KB — ` +
            "too large to check without validating a fragment"
        );
      } else if (!body.trim()) {
        errors.push("expected a JSON body, got an empty response");
      } else {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          // The content-type rides along because it is usually the explanation:
          // an HTML error page from a gateway reads very differently from a
          // genuinely malformed JSON payload.
          const type = contentType ? ` (content-type: ${contentType})` : "";
          errors.push(`response body is not JSON${type}: ${err.message}`);
        }
        if (parsed !== undefined) {
          errors.push(...schemaValidate.validate(parsed, expect.schema));
        }
      }
    }

    return { passed: errors.length === 0, errors };
  };

  /**
   * Validate the caller-settable fields of a request — the `overrides` of a
   * replay, and the whole request of a compose. Everything is optional here;
   * requiredness belongs to the route, which is the only thing that knows
   * whether a missing field has a captured entry to fall back on.
   *
   * @throws {Error} with a message safe to return as a 400
   * @returns {{method?: string, path?: string, headers?: object, body?: *}}
   */
  const validateRequestFields = (fields) => {
    if (fields == null) return {};
    if (typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error("request fields must be an object");
    }

    const out = {};

    if (fields.method != null) {
      const method = String(fields.method).toUpperCase();
      if (!SENDABLE_METHODS.includes(method)) {
        throw new Error(`method must be one of: ${SENDABLE_METHODS.join(", ")}`);
      }
      out.method = method;
    }

    if (fields.path != null) {
      // `{{ base }}/orders` is a legitimate path to write, and it cannot start
      // with "/" until it is resolved. The rule is not relaxed, only deferred:
      // `sendViaProxy` runs this same validator again on the resolved request,
      // which is the pass that sees what actually goes on the wire.
      const templated = typeof fields.path === "string" && fields.path.startsWith("{{");
      if (
        typeof fields.path !== "string" ||
        !(fields.path.startsWith("/") || templated)
      ) {
        throw new Error('path must be a string starting with "/"');
      }
      // A newline would let a caller inject extra lines into the request.
      if (/[\r\n]/.test(fields.path)) throw new Error("path must be a single line");
      out.path = fields.path;
    }

    if (fields.headers != null) {
      if (typeof fields.headers !== "object" || Array.isArray(fields.headers)) {
        throw new Error("headers must be an object");
      }
      for (const [key, value] of Object.entries(fields.headers)) {
        if (typeof value !== "string" && typeof value !== "number") {
          throw new Error(`header "${key}" must be a string`);
        }
        if (/[\r\n]/.test(String(value)) || /[\r\n]/.test(key)) {
          throw new Error(`header "${key}" must not contain line breaks`);
        }
      }
      out.headers = fields.headers;
    }

    // `body` is kept as-is (string, object or explicit null); the request
    // builder below serialises it the same way it does a stored body.
    if ("body" in fields) out.body = fields.body;

    return out;
  };

  /**
   * Default `content-type: application/json` for a non-string body that has no
   * content-type of its own.
   *
   * Typing a JSON body and forgetting the header is the easy mistake, and it
   * fails confusingly upstream rather than here. A **replay** is excluded on
   * purpose — it inherits the captured content-type, and overriding that would
   * change what the device actually sent.
   *
   * Shared by compose and send-by-id because the two are the same act: a saved
   * request stores the headers as typed, not as sent, so one applying this
   * default and the other not is the difference between a body arriving parsed
   * and arriving as `null`.
   *
   * @returns {object} a copy — the caller's headers are never mutated
   */
  const withContentTypeDefault = (headers, body) => {
    const out = { ...(headers || {}) };
    const hasContentType = Object.keys(out).some(
      (h) => h.toLowerCase() === "content-type"
    );
    if (!hasContentType && body != null) {
      // A **string** body means the editor could not parse it as JSON, which is
      // how you type XML, a form, or a line of plain text. It used to go out
      // with no content-type at all, and a body with no declared type is
      // invisible on the other side: no parser claims it, so `req.body` stays
      // undefined, the mock sees nothing and the activity log records nothing —
      // which reads as "my body was dropped" when it was sent perfectly well.
      out["content-type"] =
        typeof body === "string" ? "text/plain; charset=utf-8" : "application/json";
    }
    return out;
  };

  /**
   * Build the request, loop it through the proxy, and answer `res`.
   *
   * @param {object} spec
   * @param {string} spec.instanceId  whose pipeline answers, and whose target
   *                                  host the request is aimed at
   * @param {string} spec.marker      header that tells the log this came from
   *                                  the dashboard and not from a device;
   *                                  `request-log.js` turns it into the
   *                                  `replayed`/`composed` flag the UI badges
   * @param {string} spec.verb        past-tense word for the console line
   */
  const sendViaProxy = (
    {
      instanceId,
      method,
      path,
      headers: supplied,
      body: rawBody,
      marker,
      verb,
      expect,
      variables,
    },
    res
  ) => {
    // `{{ … }}` is resolved here, at the one point every caller passes through
    // — the dashboard's Send, a collection run, the CLI and the three clients.
    // Resolving it in the dashboard instead would mean a saved request sent by
    // id went out with its braces intact, which is exactly the drift
    // `/saved-requests/:id/send` exists to prevent.
    //
    // The guard is `variables` being **present**, not being non-empty. An empty
    // map still resolves, so `{{ token }}` with nothing defined is the 400 it
    // should be rather than a request that goes out with braces in a header and
    // comes back 401. `/replay` is the one caller that passes `undefined` unless
    // asked: its headers and body come off the wire, where `{{` is just bytes
    // somebody's payload happened to contain, not a template anybody wrote.
    if (variables) {
      try {
        const resolved = template.resolveFields(
          { path, headers: supplied, body: rawBody },
          variables
        );
        // Validated **again** on the way out. The first pass checked the
        // template text; a variable holding a CRLF would have sailed through it
        // and injected a header or a request line. This is the pass that sees
        // what actually goes on the wire.
        const checked = validateRequestFields({
          method,
          path: resolved.path,
          headers: resolved.headers,
          body: resolved.body,
        });
        path = checked.path ?? resolved.path;
        supplied = checked.headers ?? resolved.headers;
        rawBody = "body" in checked ? checked.body : resolved.body;
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }

    const cfg = serverConfigs.find((c) => c.id === instanceId);
    if (!cfg) {
      return res
        .status(404)
        .json({ error: `Instance "${instanceId}" is not configured` });
    }
    if (!store.proxyPort) {
      return res.status(503).json({ error: "Proxy is not listening yet — try again" });
    }

    const targetHost = new URL(cfg.target).hostname;

    // With SSL proxying off the request would be tunneled straight upstream —
    // no mocks, nothing logged. Refuse rather than silently do something other
    // than what was asked for.
    if (store.hostSettings[targetHost]?.ssl !== true) {
      return res.status(409).json({
        error: `SSL proxying is off for "${targetHost}" — enable it to send this request`,
      });
    }

    // Folded to lowercase for the length of this function: the hop-by-hop strip
    // below, the content-type check and the recomputed content-length all match
    // on that form, and a caller may legitimately have written `Content-Type`.
    // The spellings come back in the last step before the request goes out —
    // see utils/header-case.js.
    const { headers, names: headerNames } = headerCase.normalize(supplied);

    // Hop-by-hop and length fields are Node's to recompute.
    [
      "content-length",
      "connection",
      "proxy-connection",
      "accept-encoding",
      "host",
    ].forEach((h) => delete headers[h]);
    // Re-forced *after* the caller's headers: nothing supplied from outside may
    // redirect this at another host, nor hide where it came from.
    headers.host = targetHost;
    headers["accept-encoding"] = "identity";
    headers[marker] = "1";

    let body = null;
    if (rawBody != null) {
      if (typeof rawBody === "string") {
        body = rawBody;
      } else if ((headers["content-type"] || "").includes("urlencoded")) {
        // Not `new URLSearchParams(rawBody)`: that renders a nested value as
        // the text "[object Object]". See utils/form-encode.js.
        body = encodeForm(rawBody);
      } else {
        body = JSON.stringify(rawBody);
      }
    }

    // Set Content-Length ourselves. Without it Node falls back to
    // `Transfer-Encoding: chunked`, that header rides along to the instance
    // app, and http-proxy-middleware's fixRequestBody then adds its own
    // Content-Length when forwarding upstream — a request carrying both is
    // malformed, and the upstream answers 400. Sending anything with a body
    // failed this way regardless of overrides.
    if (body != null) headers["content-length"] = Buffer.byteLength(body);

    const outbound = http.request(
      {
        host: "127.0.0.1",
        port: store.proxyPort,
        path: `http://${targetHost}${path}`,
        method,
        headers: headerCase.applyNames(headers, headerNames),
        timeout: 30000,
      },
      (upstream) => {
        // The body is held **only** when an expectation is going to read it.
        // Without one this stays the drain it has always been, so running a
        // collection of unchecked requests costs exactly what it did before.
        // `accept-encoding: identity` is forced above, so what arrives here is
        // already the plain bytes.
        let body = "";
        let truncated = false;

        if (!expect) {
          upstream.resume(); // drain — the pipeline's logger captures the body
        } else {
          upstream.setEncoding("utf8");
          upstream.on("data", (chunk) => {
            // Past the cap the chunks keep coming and keep being dropped: the
            // stream still has to reach `end` for the socket to close.
            if (truncated) return;
            if (body.length + chunk.length > MAX_VALIDATE_BYTES) {
              truncated = true;
              body = "";
              return;
            }
            body += chunk;
          });
        }

        upstream.on("end", () => {
          if (res.headersSent) return;
          const payload = { ok: true, status: upstream.statusCode };

          if (expect) {
            payload.expect = checkExpectation(expect, {
              status: upstream.statusCode,
              contentType: upstream.headers["content-type"] || "",
              body,
              truncated,
            });
          }

          // `ok: true` still means "it went out and came back". A response
          // that failed its expectation is a successful send of a request
          // whose answer was wrong, and the two have to stay distinguishable.
          const verdict = payload.expect
            ? payload.expect.passed
              ? " ✓"
              : ` ✗ ${payload.expect.errors.length} problem${payload.expect.errors.length === 1 ? "" : "s"}`
            : "";
          console.log(
            `↻ [ADMIN] ${verb} ${method} ${path} → ${upstream.statusCode}${verdict}`
          );
          res.json(payload);
        });
      }
    );
    outbound.on("timeout", () => outbound.destroy(new Error("request timed out")));
    outbound.on("error", (err) => {
      if (!res.headersSent)
        res.status(502).json({ error: `Request failed: ${err.message}` });
    });
    if (body != null) outbound.write(body);
    outbound.end();
  };
  router.post("/replay", (req, res) => {
    const { id, overrides, expect, variables } = req.body || {};
    if (!id) return res.status(400).json({ error: "Required field: id" });

    const entry = requestLog.getEntry(id);
    if (!entry) return res.status(404).json({ error: `Log entry "${id}" not found` });

    let edits;
    let expectation;
    let vars;
    try {
      edits = validateRequestFields(overrides);
      // Top-level rather than inside `overrides`: an expectation is not an
      // edit to what was captured, it is a question about the answer.
      expectation = validateExpect(expect);
      // `undefined` unless the caller asked for templating — see the note in
      // sendViaProxy about `{{` arriving off the wire.
      vars = Object.hasOwn(req.body || {}, "variables")
        ? template.validateVariables(variables)
        : undefined;
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    // A truncated body only matters when we're rebuilding the request from the
    // log. Supplying one is exactly how you replay a request that was stored
    // cut, so the guard lifts when the caller sends a body.
    if (entry.requestTruncated && edits.body === undefined) {
      return res.status(409).json({
        error:
          "Request body was truncated in the log — replay would send an incomplete body. Use Retry with modifications to supply the body.",
      });
    }
    // Overrides layer on top of what was captured; anything not overridden is
    // replayed as it was.
    return sendViaProxy(
      {
        instanceId: entry.instanceId,
        method: edits.method || entry.method,
        path: edits.path || entry.path,
        // The log's map is lowercase — Node's parse, not a choice — so the
        // captured spellings go back on before the merge is handed over, or a
        // replay would send `tokenid` where the device sent `tokenId` and stop
        // being a faithful re-send. It also folds the two spellings of a header
        // the retry editor re-sent together: `sendViaProxy` normalises what it
        // is given, so this only has to say what the names *are*.
        headers: headerCase.applyNames(
          { ...entry.requestHeaders, ...(edits.headers || {}) },
          entry.requestHeaderCase
        ),
        body: edits.body !== undefined ? edits.body : entry.requestBody,
        marker: "x-ir-proxy-replayed",
        verb: "Replayed",
        expect: expectation,
        variables: vars,
      },
      res
    );
  });

  // ── Compose a request from scratch ─────────────────────────────────────────
  // The same send path, with nothing captured to fall back on: the caller
  // supplies every field, and picks the instance instead of inheriting it.

  router.post("/send", (req, res) => {
    const { instanceId, method, path, headers, body, expect, variables } = req.body || {};
    if (!instanceId) {
      return res.status(400).json({ error: "Required field: instanceId" });
    }

    let fields;
    let expectation;
    let vars;
    try {
      fields = validateRequestFields({ method, path, headers, body });
      expectation = validateExpect(expect);
      vars = template.validateVariables(variables);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    // Required here and not in the validator: a replay has a captured path to
    // fall back on, a composed request has nothing.
    if (!fields.path) {
      return res
        .status(400)
        .json({ error: 'Required field: path (must start with "/")' });
    }

    return sendViaProxy(
      {
        instanceId,
        method: fields.method || "GET",
        path: fields.path,
        headers: withContentTypeDefault(fields.headers, fields.body),
        body: fields.body !== undefined ? fields.body : null,
        marker: "x-ir-proxy-composed",
        verb: "Sent",
        expect: expectation,
        variables: vars,
      },
      res
    );
  });

  // ── Saved requests ─────────────────────────────────────────────────────────
  // Named requests for the composer. `request-store.js` owns the on-disk
  // layout; this only validates — and validates with the *same* rules a send
  // uses, so anything that can be saved is something that could be sent.

  router.get("/saved-requests", (_req, res) => {
    res.json({ requests: requestStore.list() });
  });

  router.post("/saved-requests", (req, res) => {
    const {
      name,
      instanceId,
      method,
      path: reqPath,
      headers,
      body,
      expect,
      variables,
      collectionId,
    } = req.body || {};

    let clean;
    try {
      // The same standard as an instance or profile label: this string is
      // rendered in the dashboard, the page that can read every decrypted
      // request.
      clean = instanceManager.validateName(name);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    if (!serverConfigs.some((c) => c.id === instanceId)) {
      return res
        .status(404)
        .json({ error: `Instance "${instanceId}" is not configured` });
    }

    let fields;
    let expectation;
    let vars;
    try {
      fields = validateRequestFields({ method, path: reqPath, headers, body });
      // The same call a send makes, so a schema that could never be honoured
      // cannot be stored — the rule the whole route already lives by.
      expectation = validateExpect(expect);
      vars = template.validateVariables(variables);
      // Templates are checked for *shape* on save, not for resolvability: a
      // `{{ token | encodeUri }}` typo would otherwise surface halfway through
      // a collection run, long after the editor that could fix it was closed.
      // Undefined variables stay legal here — a suite supplies them at send
      // time, which is the point of sending by id with an override.
      template.assertParsable(fields);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!fields.path) {
      return res
        .status(400)
        .json({ error: 'Required field: path (must start with "/")' });
    }

    try {
      const saved = requestStore.save({
        name: clean,
        instanceId,
        ...fields,
        expect: expectation,
        variables: vars,
      });
      // Placed only when the caller names a collection, and it always does when
      // the composer was opened from one. Saving over an existing request from
      // anywhere else says nothing about where it belongs, so it stays put.
      if (collectionId != null) collectionStore.assign(saved.id, collectionId);
      console.log(`💾 [ADMIN] Saved request "${saved.name}"`);
      res.json({ ok: true, request: saved });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /**
   * Send a saved request **by id** — the whole record, assembled here.
   *
   * This exists so that "what a saved request becomes when it is sent" is
   * written **once**. The dashboard's collection runner, the CLI and the three
   * drop-in clients all need it, and four hand-assembled copies of the same
   * payload is how a field added to a saved request silently stops being sent
   * by three of them. `expect` was exactly that field.
   *
   * `{ expect }` in the body **replaces** the stored expectation for this call
   * — which is what lets a test suite keep its schemas in version control next
   * to the tests rather than only inside the dashboard. `expect: null` sends
   * with no check at all.
   *
   * There is still deliberately **no collection run endpoint**: order, progress
   * and Stop belong to whoever is watching the run, which is why every runner
   * loops this route itself.
   */
  router.post("/saved-requests/:id/send", (req, res) => {
    const record = requestStore.get(req.params.id);
    if (!record) {
      return res.status(404).json({ error: "That saved request no longer exists" });
    }

    const override = Object.hasOwn(req.body || {}, "expect");

    let expectation;
    let vars;
    try {
      // The stored expectation is re-validated rather than trusted: these are
      // files in a directory somebody can edit, and a hand-written `$ref` in
      // one would otherwise reach the validator as something it must refuse
      // halfway through a run instead of up front.
      expectation = validateExpect(override ? req.body.expect : record.expect);
    } catch (err) {
      return res.status(err.status || 400).json({
        error: override
          ? err.message
          : `Saved request "${record.id}" has an expectation that cannot be honoured: ${err.message}`,
      });
    }

    try {
      // Variables **merge** over the stored ones, where `expect` above replaces
      // them. The asymmetry is deliberate: an expectation is one whole
      // statement about the answer, so half of it is meaningless, while
      // variables are independent values — and the reason to pass any from
      // outside is usually a single one, the credential the file should not be
      // carrying. Replacing would make a caller restate every other variable to
      // supply the one it has.
      vars = {
        ...template.validateVariables(record.variables),
        ...template.validateVariables(req.body?.variables),
      };
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    return sendViaProxy(
      {
        instanceId: record.instanceId,
        method: record.method || "GET",
        path: record.path,
        headers: withContentTypeDefault(record.headers, record.body),
        body: record.body ?? null,
        marker: "x-ir-proxy-composed",
        verb: `Sent "${record.name}"`,
        expect: expectation,
        variables: vars,
      },
      res
    );
  });

  /**
   * Update just the variables of a saved request.
   *
   * Narrow on purpose. Sending is not saving here — a path or a body typed into
   * the editor is a one-off, and closing the modal is meant to throw it away.
   * Variables are the exception because they are the request's **inputs**
   * rather than its content: the reason to put a value in the Variables tab
   * instead of inline in the path is so that it stays. One that evaporated on
   * every Send would leave the tab useful only to whoever remembered to press
   * Save afterwards.
   *
   * So this route exists rather than re-saving the whole record, which would
   * quietly persist the path and body edits that are supposed to be temporary.
   */
  router.patch("/saved-requests/:id", (req, res) => {
    const record = requestStore.get(req.params.id);
    if (!record) {
      return res.status(404).json({ error: "That saved request no longer exists" });
    }
    if (!Object.hasOwn(req.body || {}, "variables")) {
      return res.status(400).json({ error: "Only `variables` can be patched" });
    }

    try {
      const variables = template.validateVariables(req.body.variables);
      const saved = requestStore.save({
        ...record,
        variables: Object.keys(variables).length ? variables : null,
      });
      res.json({ ok: true, request: saved });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete("/saved-requests/:id", (req, res) => {
    if (!requestStore.remove(req.params.id)) {
      return res.status(404).json({ error: "That saved request no longer exists" });
    }
    // Drop it out of whatever collection held it. The screen would hide a
    // dangling id anyway, but leaving it behind means the next request that
    // slugs to the same name silently inherits its position.
    collectionStore.removeRequest(req.params.id);
    console.log(`🗑  [ADMIN] Deleted saved request "${req.params.id}"`);
    res.json({ ok: true, id: req.params.id });
  });
};
