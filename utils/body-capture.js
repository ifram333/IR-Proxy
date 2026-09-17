/**
 * body-capture.js — reading a request body without changing it.
 *
 * Parsing a body is what puts it where the mocks and the activity log can see
 * it: nothing populates `req.body` for a type no parser claims, and the log
 * records `req.body`. But parsing **consumes the stream**, so the proxy can no
 * longer pipe the request through and has to write a body back out — and both
 * halves of that had a way of altering traffic this proxy is supposed to be
 * transparent about:
 *
 *  • **The round-trip is lossy.** `fixRequestBody` re-serialises `req.body`,
 *    and for `x-www-form-urlencoded` that means `querystring.stringify` over
 *    whatever `qs` made of the bytes — where `[` and `]` are nested keys. A
 *    1282-character body containing a `[` reached the upstream as 136
 *    characters, cut at the first bracket, answered `200`. `keepRaw` +
 *    `writeRawBody` forward the original bytes instead.
 *
 *  • **The size limit turned into an error the backend never sent.** Express's
 *    parsers default to `100kb` and answer `413` past it, so a large JSON or
 *    form request was rejected *by the proxy* and never forwarded at all —
 *    while the same payload as `image/png`, which no parser claims, went
 *    through untouched. An intercepting proxy inventing a 4xx is worse than one
 *    that cannot show you the body, so anything past `MAX_PARSE_BYTES` is now
 *    left unparsed and streamed through: it reaches the upstream intact, and it
 *    is invisible in the dashboard, which is the honest half to give up.
 */

"use strict";

const express = require("express");
const { originalNames } = require("./header-case");

/**
 * How large a request body may be before it is forwarded without being read.
 *
 * The cost of parsing is paid twice and per in-flight request — the raw buffer
 * plus the parsed value — so this is a memory bound, not a policy about what
 * the upstream will accept. Nothing is rejected for exceeding it.
 */
const MAX_PARSE_BYTES = (() => {
  const raw = process.env.IR_PROXY_MAX_PARSE_BYTES;
  if (raw === undefined) return 5 * 1024 * 1024;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.warn(
      `⚠️  [Body] Ignoring IR_PROXY_MAX_PARSE_BYTES="${raw}" — expected a positive integer.`
    );
    return 5 * 1024 * 1024;
  }
  return value;
})();

/**
 * Whether this request's content-type is one of `fragments`, *and* it is small
 * enough to be worth holding.
 *
 * A body with no `Content-Length` (chunked) can't be checked in advance, so it
 * is read and the parser's own `limit` is what stops it — the one case where a
 * `413` can still come from here rather than from the upstream.
 */
const _claims = (fragments) => (req) => {
  const length = Number(req.headers["content-length"]);
  if (Number.isFinite(length) && length > MAX_PARSE_BYTES) return false;
  const type = (req.headers["content-type"] || "").toLowerCase();
  return fragments.some((f) => type.includes(f));
};

/**
 * Body-parser `verify` hook: keep the bytes exactly as they arrived.
 *
 * body-parser has already read them all into memory to hand `req.body` over, so
 * this holds a second reference, not a second copy of the traffic.
 */
function keepRaw(req, res, buf) {
  if (buf && buf.length) req.rawBody = buf;
}

/**
 * The body parsers an instance app mounts, in order.
 *
 * `limit` matches the skip threshold so the two can never disagree: anything
 * `_claims` lets through is by definition inside it.
 */
function parsers() {
  const common = { verify: keepRaw, limit: MAX_PARSE_BYTES };
  return [
    express.json({ ...common, type: _claims(["application/json", "+json"]) }),
    express.urlencoded({
      ...common,
      extended: true,
      type: _claims(["application/x-www-form-urlencoded"]),
    }),
    // Text bodies too, or they reach neither the mocks nor the activity log. A
    // composed request carrying XML or a line of plain text would otherwise
    // look like it had been sent empty.
    express.text({
      ...common,
      type: _claims(["text/", "application/xml", "+xml"]),
    }),
  ];
}

/**
 * Forward the body exactly as it arrived, if we kept it.
 *
 * @returns {boolean} whether the body was written — `false` means no parser
 *   claimed this request, the stream was never consumed, and http-proxy pipes
 *   it through itself (which is how multipart, binary and anything oversized
 *   get through untouched).
 */
function writeRawBody(proxyReq, req) {
  const raw = req.rawBody;
  // `readableLength` is fixRequestBody's own guard for a parser that gave up
  // half way: the stream still holds bytes, so it is not ours to replace.
  if (!raw || !raw.length || req.readableLength !== 0) return false;
  // Spelled the way the client spelled it, like every other header here.
  const names = originalNames(req.rawHeaders);
  proxyReq.setHeader(names["content-length"] || "Content-Length", raw.length);
  proxyReq.write(raw);
  return true;
}

module.exports = { MAX_PARSE_BYTES, keepRaw, parsers, writeRawBody };
