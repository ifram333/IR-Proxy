# Roadmap

Work that has been **measured or reproduced** and deliberately not done yet.

Everything here carries the evidence that produced it, so picking an item up does
not mean re-deriving the problem first. Nothing in this file is a plan of record
— it is a list of known holes with a proposed shape for each.

Written in English to match the rest of the docs, even though the commit log is
in Spanish.

---

## 1 · Request bodies: binary and multipart

**Status:** binary is broken and says it worked. Multipart half-works and is
invisible.

### What happens today

Measured through `POST /__admin/send` against an upstream that reports the raw
bytes it received:

| Body type                           | Sent?                                | Visible to mocks / the log? |
| ----------------------------------- | ------------------------------------ | --------------------------- |
| `application/x-www-form-urlencoded` | yes — as a string or an object       | yes                         |
| GraphQL (a JSON envelope)           | yes                                  | yes                         |
| `multipart/form-data`               | bytes pass through, with peers below | **no**                      |
| binary (`image/png`, …)             | **no — silently corrupted**          | **no**                      |

**Binary is corrupted on the way out.** `sendViaProxy` ends with
`outbound.write(body)` on a **string**, which Node encodes as UTF-8, so every
byte above `0x7F` becomes two:

```
sent:     89 50 4e 47 0d 0a 1a 0a 00 ff fe 01              (11 bytes)
arrived:  c2 89 50 4e 47 0d 0a 1a 0a 00 c3 bf c3 be 01     (15 bytes)
/send →   200
```

The `200` is the problem, not the corruption. This is the same false green that
`schema-validate.js` refuses to produce and that the block clients refuse to
claim — the one failure mode this tool treats as worse than not having the
feature.

**Multipart passes the bytes through verbatim**, so a hand-written body with
explicit CRLF arrives intact (LF-only does not, and RFC 7578 requires CRLF — the
editor gives you LF). But no multipart parser is mounted, so `req.body` stays
`undefined`: the request is invisible to `match(req)` and the activity log
records no body at all. Which leads to the sharp edge —

**A Retry of a captured multipart request sends an empty body, with a 200:**

```
/replay  → 200 {"ok":true,"status":200}
upstream → content-length: 0, bytes: 0
```

`request-log.js` never had the body to give back, and the replay route has no
guard for "the log could not capture this" the way it has one for
`requestTruncated`.

And there is no way to attach a file, which is what multipart is for.

**The same blind spot now has a second cause.** Since `utils/body-capture.js`,
a request body over `MAX_PARSE_BYTES` (`IR_PROXY_MAX_PARSE_BYTES`, 5 MB) is
forwarded intact but never read — deliberately, because the alternative was the
proxy answering `413` itself. It lands in the dashboard looking like a request
with no body, exactly as multipart does. Worth a marker on the log entry
(`requestBodySkipped: <bytes>`) so the inspector can say _"body too large to
capture (7.4 MB)"_ rather than showing nothing; the field would also let a
Retry refuse instead of silently re-sending an empty body.

One narrow hole is left in that skip: a body with **no `Content-Length`**
(chunked) cannot be measured in advance, so it is read and the parser's own
`limit` is what stops it — the one case where a `413` can still originate here
rather than at the upstream. Closing it means reading the stream in chunks and
falling back to a pass-through once the budget is spent, which is real work for
a case no device has produced yet.

### Proposed shape

Two steps, independently useful. The first is the one worth doing on its own.

**a) Stop lying** — small.

- Refuse a send whose content-type no parser claims _and_ whose string body holds
  code points above `0x7F`: a `400` naming the reason, next to
  `validateRequestFields` in `utils/admin/send.js`.
- Refuse a replay whose capture has no body but whose original carried one — the
  same shape as the existing `requestTruncated` `409`, and for the same reason:
  sending something that is not what was captured is worse than refusing.

**b) Make it work** — larger.

- A `bodyEncoding: "base64"` field on a saved request, decoded to a `Buffer` in
  `sendViaProxy` before the write. That unblocks binary and file uploads in one
  move, and it belongs in `sendViaProxy` for the same reason `expect` and
  `variables` do: four callers share that payload, and a field added anywhere
  else stops being sent by three of them.
- `express.raw()` in the instance app for the types nothing else claims, or the
  body stays invisible to the mocks and the log — the parser is what puts a body
  where they can see it (see the `express.text()` note in CLAUDE.md; this is the
  same lesson).
- A file picker in the request editor, writing base64 into the field.

### Why it is not done

Asked and deferred: the current work is elsewhere. Nothing here blocks the JSON
and form-encoded flows, which is what the tool is used for today.

---

## 2 · Filters on body fields that are not variables

**Status:** built, and **reverted**. Do not build it again without reading this.

> **2026-08-26 — tried and removed.** A backend here turned out to want every
> string value of the body percent-encoded (reproduced independently in Postman,
> so not a proxy behaviour). The shape built was `encodeValues`: one named
> encoder from a closed list, stored on the request record beside `expect` and
> `variables`, applied in `sendViaProxy` **after** the templates resolve, and
> threaded through `/saved-requests/:id/send` so the CLI and the clients
> inherited it. It passed its own tests and the round trip, and it did **not**
> solve the problem in practice — the reason was not captured, and that is the
> first thing to establish before anyone tries again.
>
> The decision taken instead: **the body goes out exactly as written.** Encoding
> a payload is the author's job, done in the fixture, even though that means
> maintaining an encoded copy by hand. A transform the tool applies silently to
> every value is a second thing to suspect when a payload is rejected, and this
> proxy exists to remove suspects, not add them.
>
> If it does come back: the encoder that matched that backend was _everything
> outside `[A-Za-z0-9._]`, uppercase hex_ — **not** `encodeURIComponent`, which
leaves `-`, `(`, `)`, `!`, `'`, `\*`and`~` alone. That gap is real and it is
> what a naive implementation gets wrong.

**The ask:** apply `encodeURIComponent` and the other `{{ … | filter }}` filters
to a field of the body directly, so a nested document does not have to be
hand-escaped into a JSON string to be sent as a form.

**What actually closed it:** `utils/form-encode.js`. For a form the _encoding_
was never the missing piece — `URLSearchParams` applies it, which is also why a
`{{ }}` in a form field must **not** carry `| encodeURIComponent`: that encodes
it twice. What was missing was the _serialisation_ of a nested value, which
rendered as the literal text `[object Object]`. A body can now be written as
plain nested JSON and edited as such.

**What is still not covered:** a **JSON** body — not a form — holding a field
that must contain a percent-encoded value which comes from a literal rather than
a variable. Today you type the encoded literal, or move it into a variable and
use the filter there.

**Why it was not built:**

- It needs new syntax **inside the body**: a suffixed key (`"data|json"`) or a
  magic wrapper (`{ "$json": … }`). Both collide with real keys, both need
  refusing-by-name for a typo — the `schema-validate.js` rule, since a filter
  silently ignored is a body silently sent wrong — and both have to be
  understood by the CLI and the three drop-in clients, or a saved request means
  different things depending on who sends it.
- For the one content-type where encoding is mandatory, the content-type already
  decides it. A filter would be a second, overridable answer to a settled
  question.

**A related sharp edge, worth writing down:** a `{{ … }}` inside a _variable's
value_ is not resolved. `resolve()` substitutes in one pass (`String.replace`
with a function), so substituted values are never re-scanned — putting a whole
document into a variable leaves any template inside it literal, and it reaches
the wire as `%7B%7Bemail+%7C+encodeURIComponent%7D%7D`. That is deliberate:
re-scanning would make a body's meaning depend on its own data. But it is why
escaping the document into the body was the only way that worked before
`form-encode.js`, and it is the first thing to check when a variable "doesn't
resolve".

---

## 3 · Response header case in the inspector

**Status:** request headers now show the spelling the client sent; response
headers still show Node's lowercase fold.

`utils/header-case.js` puts request field names back on the way upstream and
records them beside the log's normalised map (`requestHeaderCase`), which the
inspector, its cURL copy and the retry editor rejoin through `withHeaderCase`.

Response headers get none of that. They are lowercased by Node's **client**
parser when the proxy reads the upstream response, and recovering them means
capturing `proxyRes.rawHeaders` in `mock-pipeline.js` and threading it to
`request-log.js` as a `responseHeaderCase` twin.

It is the same rule in the other direction, so it is cheap to write. It was left
out because it is not what anyone was looking at, and it adds a second per-entry
field to a log whose memory is deliberately tuned.

---

## 4 · Schema expectations above 1 MB

**Status:** by design, and the design may need to move.

`sendViaProxy` buffers a response body only when there is an `expect` to read it,
and stops at `MAX_VALIDATE_BYTES` (1 MB, `utils/admin/send.js`). Past that it
reports that it _could not check_ rather than validating a fragment — the same
call the replay route makes on a truncated request body, and the right one: half
a JSON document does not parse, and a green tick on a body nobody read is the
failure this whole feature exists to avoid.

The number is the open question, not the behaviour. As of 2026-08-26 the largest
responses in play are around 1 MB in the worst case, so it has not bitten yet.
If schema-checked responses start crossing it, raise the constant — but weigh it
against §5: this buffer is per in-flight request, not per stored entry, so its
cost scales with concurrency rather than with `IR_PROXY_LOG_SIZE` — the same shape
as `IR_PROXY_MAX_PARSE_BYTES` in the table there.

---

## 5 · Reference: sizes, limits, and what they cost

Not a task — the numbers, so nobody has to measure them again.

### How big a body can be

Measured end to end on the real proxy. **Nothing here refuses a request for
being large except the 512 KB save**, which says so in a sentence:

| Up to  | What still works                                                   |
| ------ | ------------------------------------------------------------------ |
| 256 KB | everything — the body shows **whole** in the inspector             |
| 512 KB | sending; the log keeps a 256 KB excerpt flagged `truncated`        |
| 5 MB   | sending; past 512 KB it can no longer be **saved** as a request    |
| 16 MB  | sending; past 5 MB nothing reads it, so it is invisible in the log |

Where each number lives, and what raising it costs:

| Number | Constant                                             | Raising it costs                                       |
| ------ | ---------------------------------------------------- | ------------------------------------------------------ |
| 256 KB | `IR_PROXY_BODY_CHARS` (`utils/request-log.js`)       | log memory, linearly — see the table below             |
| 512 KB | `MAX_BYTES` (`utils/request-store.js`)               | disk per saved request; answers `413` naming the cap   |
| 5 MB   | `IR_PROXY_MAX_PARSE_BYTES` (`utils/body-capture.js`) | held twice per **in-flight** request, so × concurrency |
| 16 MB  | `ADMIN_JSON_LIMIT` (`proxy-server.js`)               | nothing meaningful — it only bounds the API call       |

The 16 MB one was `100kb` (Express's default) until it was found by a real sync
payload, and it answered with an HTML error page, so the request read as _cut_
rather than _refused_. It is deliberately set well past anything the dashboard
sends: the limits that should bind a body are the three above it, which each say
something useful when they bind.

**The first thing you lose as payloads grow is the inspector, not the send.**
Past 256 KB the request still goes out whole and the log shows an excerpt; past
512 KB it stops being saveable, which is the first one that will actually stop
somebody working.

### What the activity log costs

Real traffic through the real proxy, 1000 entries whose responses all exceed the
cap:

| `IR_PROXY_BODY_CHARS` | heap held | RSS    |
| --------------------- | --------- | ------ |
| 128 KB                | 127 MB    | 348 MB |
| 256 KB (current)      | 252 MB    | 481 MB |

Close to linear, and the ceiling is `IR_PROXY_LOG_SIZE × 2 × IR_PROXY_BODY_CHARS` — both
bodies of every entry at the cap.

It only reads as linear since `_detach` (`utils/request-log.js`). Before it,
truncation used `str.slice()`, which in V8 is a **view** that keeps its parent
alive: 300 × 8 MB responses cost **2.4 GB** of heap while `stats()` reported
75 MB, because it counts what was _stored_ and the cost was in what was still
_referenced_. The tell was that the number did not move when the cap changed.

**The binding constraint is the browser, not the server.** The dashboard fetches
`/__admin/log-history?limit=1000` with bodies included and keeps all 1000
(`MAX_CLIENT_ENTRIES` in `public/js/modules/entries.js`). For sustained work
against large services, lower the entry count rather than the cap:

```bash
IR_PROXY_LOG_SIZE=300 npm run dev   # 300 × 256 KB ≈ 75 MB
```
