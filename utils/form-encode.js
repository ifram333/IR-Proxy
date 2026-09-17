/**
 * form-encode.js — turning a composed body into `a=1&b=2`.
 *
 * `new URLSearchParams(object)` is almost right, and wrong in the one place it
 * matters: it stringifies every value with `String(v)`, so a **nested** one
 * becomes the literal text `[object Object]`. A body of
 * `{ email: "…", data: { … } }` went out as
 * `email=…&data=%5Bobject+Object%5D` — 49 bytes where 1400 were meant — and
 * came back `200`, because the request was perfectly well-formed and simply
 * said nothing. The only way round it was to hand-escape the nested document
 * into a JSON string, which is unreadable and un-editable.
 *
 * So nesting is given the two shapes a form actually has:
 *
 *   • an **object** becomes JSON — `data={"a":1}` — which is how every API that
 *     takes a document in a form field takes it;
 *   • an **array** becomes repeated keys — `tag=a&tag=b` — which is the
 *     urlencoded convention for a multi-valued field, and what
 *     `express.urlencoded({ extended: true })` parses straight back into an
 *     array. Its elements go through the same rule, so an array of objects is
 *     `item={"a":1}&item={"b":2}` rather than two `[object Object]`.
 *
 * Primitives keep `URLSearchParams`' own coercion exactly, so nothing that
 * already worked changes shape.
 *
 * Pure — no I/O. Encoding itself stays `URLSearchParams`' job; this only
 * decides what text each field holds before it gets encoded.
 */

"use strict";

const _isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** One field's text: JSON for a document, `String(v)` for anything else. */
const _value = (v) =>
  _isPlainObject(v) || Array.isArray(v) ? JSON.stringify(v) : String(v);

/**
 * @param {*} body  the composed body, already resolved of any `{{ … }}`
 * @returns {string} an `application/x-www-form-urlencoded` payload
 */
function encodeForm(body) {
  // Anything that isn't a plain object was never a form to begin with —
  // leave it to URLSearchParams, which is what handled it before.
  if (!_isPlainObject(body)) return new URLSearchParams(body).toString();

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((v) => params.append(key, _value(v)));
    else params.append(key, _value(value));
  }
  return params.toString();
}

module.exports = { encodeForm };
