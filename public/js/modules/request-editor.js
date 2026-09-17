/**
 * request-editor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One modal, two ways in:
 *
 *  • **Retry with modifications** — edit a request a device already made.
 *  • **New request** — compose one from scratch against a chosen instance.
 *
 * They share this module because they are the same editor: method, path,
 * headers, body, send. The only real difference is where the target comes from,
 * and that difference is a single field — a fixed host in replay mode, a picker
 * in compose mode. Splitting them would mean two copies of the Ace wiring
 * (instances, the resize dance, tab switching) drifting apart.
 *
 * Whichever mode it is, the request goes **through the proxy**, so mocks,
 * latency and the 503 switch all apply and the result lands in the activity log
 * next to the device traffic. That is the whole reason this lives here instead
 * of in a separate API client.
 *
 * Requests can be **saved under a name** from either mode, and loading one
 * always lands in compose mode — a saved request has no captured entry behind
 * it, so Retry's rules don't apply to it. `Send` and `Save` read the editor
 * through the same `readFields`, so it is impossible to save something that
 * couldn't be sent. Where a save *lands* is `collections.js`'s business: this
 * only carries the collection it was opened from, so that composing from inside
 * a group saves into that group instead of into Ungrouped.
 *
 * The host is never editable in replay mode: a replay is scoped to the instance
 * that captured it, which is what keeps the mock pipeline and the log entry
 * coherent. The server re-forces `host` after merging, so it's enforced on both
 * ends.
 *
 * Errors are shown inside the modal rather than as a toast — a malformed JSON
 * body is something you fix right there, and a message that fades away while
 * you're still looking at the editor is useless.
 *
 * The DOM ids are still `replay-*`. They predate compose mode and renaming them
 * would churn ~50 lines of markup and CSS for no behaviour change; the module
 * name is the one that had to tell the truth.
 */
import { state } from "./state.js";
import { api, toast, showPrompt, showConfirm, withHeaderCase } from "./util.js";
import { ensureAce } from "./editor.js";
import { replayEntry, sendComposed } from "./entries.js";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

let _headersEditor = null;
let _bodyEditor = null;
let _varsEditor = null;
let _expectEditor = null;
let _entryId = null; // replay mode only
let _instanceId = null; // the captured instance, in replay mode
let _mode = "replay"; // "replay" | "compose"
let _saved = []; // the saved-request list, as last fetched
let _savedId = null; // which saved request is loaded, if any
let _schemaFiles = []; // the schemas/ listing, as last fetched
let _schemaFileId = null; // which schema file the pane was filled from, if any
let _collectionId = null; // the collection this session composes into, if any

const el = (id) => document.getElementById(id);

function setError(message) {
  const box = el("replay-error");
  if (!box) return;
  box.textContent = message || "";
  box.hidden = !message;
}

function makeEditor(containerId, mode) {
  const editor = ace.edit(containerId);
  editor.setTheme("ace/theme/monokai");
  editor.session.setMode(`ace/mode/${mode}`);
  editor.setOptions({
    fontSize: "13px",
    showPrintMargin: false,
    useWorker: false,
    wrap: true,
    tabSize: 2,
  });
  return editor;
}

/** Built once, on first open — Ace is loaded lazily. */
function ensureEditors() {
  if (_headersEditor) return;
  _headersEditor = makeEditor("replay-headers-editor", "json");
  _bodyEditor = makeEditor("replay-body-editor", "json");
  _varsEditor = makeEditor("replay-variables-editor", "json");
  _expectEditor = makeEditor("replay-expect-editor", "json");
}

/** Pretty-print whatever the log stored, so it's editable as text. */
function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value; // plain text / form-encoded — leave it alone
    }
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Put the variables into their pane, or clear it.
 *
 * @param {Record<string,string>|null} variables
 */
function fillVariables(variables) {
  const has = variables && Object.keys(variables).length;
  _varsEditor.setValue(has ? JSON.stringify(variables, null, 2) : "", -1);
}

/**
 * Read the Variables pane.
 *
 * Only the *shape* is checked here — that it parses and is a flat object.
 * Whether a name is usable, whether a filter exists and whether every `{{ … }}`
 * in the request resolves is the server's call, made in one place
 * (`utils/template.js`) for the dashboard, the CLI and the clients alike.
 * Re-deriving any of it here is how the two would come to disagree about what a
 * saved request means.
 *
 * @returns {{variables: object|null}|null} null with the error already on screen
 */
function readVariables() {
  const text = _varsEditor.getValue().trim();
  if (!text) return { variables: null };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    switchRequestTab("variables");
    setError(`Variables: ${err.message}`);
    return null;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
    switchRequestTab("variables");
    setError('Variables: must be a JSON object, like {"token": "abc"}.');
    return null;
  }
  return { variables: Object.keys(parsed).length ? parsed : null };
}

/**
 * Put an expectation into the pane, or clear it.
 *
 * @param {{status?: number, schema?: object}|null} expectation
 */
function fillExpect(expectation) {
  _schemaFileId = null;
  el("replay-expect-status").value = expectation?.status ?? "";
  _expectEditor.setValue(
    expectation?.schema ? JSON.stringify(expectation.schema, null, 2) : "",
    -1
  );
}

/**
 * Parse the schema editor.
 *
 * Shared by the expectation and by "Save as file", so a schema that doesn't
 * parse is refused in the same words whichever button you pressed — and so a
 * file written to `schemas/` can never be one the send path would then choke
 * on.
 *
 * @returns {{schema: object|null}|null} `{ schema: null }` for an empty editor,
 *   null with the error already on screen for one that can't be read.
 */
function readSchema() {
  const text = _expectEditor.getValue().trim();
  if (!text) return { schema: null };

  let schema;
  try {
    schema = JSON.parse(text);
  } catch (err) {
    switchRequestTab("expect");
    setError(`Schema: ${err.message}`);
    return null;
  }
  if (typeof schema !== "object" || Array.isArray(schema) || schema === null) {
    switchRequestTab("expect");
    setError("Schema: must be a JSON object.");
    return null;
  }
  return { schema };
}

/**
 * Read the Expect pane.
 *
 * Both halves are optional and both empty means "check nothing" — which is
 * exactly what a request saved before this existed already is, so the empty
 * pane and a legacy request produce the same `null`.
 *
 * @returns {{expect: object|null}|null} null with the error already on screen
 */
function readExpect() {
  const expectation = {};

  const raw = el("replay-expect-status").value.trim();
  if (raw) {
    const status = Number(raw);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      switchRequestTab("expect");
      setError("Expected status must be an HTTP status code (100-599).");
      return null;
    }
    expectation.status = status;
  }

  const parsed = readSchema();
  if (!parsed) return null;
  if (parsed.schema) expectation.schema = parsed.schema;

  // Which keywords are actually honoured is the server's call, and it is the
  // only copy of that list — re-deriving it here is how the two would drift
  // into disagreeing about what a saved schema means.
  return { expect: Object.keys(expectation).length ? expectation : null };
}

function fillMethods(selected) {
  const method = el("replay-method");
  method.innerHTML = "";
  METHODS.forEach((verb) => {
    const option = document.createElement("option");
    option.value = verb;
    option.textContent = verb;
    option.selected = verb === selected;
    method.appendChild(option);
  });
}

/**
 * Fill the instance picker (compose mode).
 *
 * Instances whose host has SSL proxying off are listed but **disabled** rather
 * than hidden. The send would 409 on them, but "why is my host missing from
 * this list?" is a worse mystery than a greyed-out row that says why — and the
 * fix (turn SSL on from the tree) is only obvious once you can see the host is
 * known.
 *
 * Eligibility is read from `hostSettings` in the cached `/config`, which is the
 * same slice the server checks before sending, so the list can't disagree with
 * the outcome.
 *
 * @returns {number} how many entries are actually selectable
 */
function fillInstances(preferredId) {
  const select = el("replay-instance");
  select.innerHTML = "";

  const instances = state.cachedData?.instances || [];
  const hostSettings = state.cachedData?.hostSettings || {};
  const eligible = [];

  instances.forEach((instance) => {
    let host;
    try {
      host = new URL(instance.target).hostname;
    } catch {
      return; // a target we can't parse is not somewhere we can send
    }
    const ssl = hostSettings[host]?.ssl === true;
    // Host first, name second. Several environments of the same app produce
    // hostnames that only differ late — `orders-qa.example.com` against
    // `orders-qa.example.net` — so when the label is truncated the half that has to
    // survive is the host, not the friendly name.
    const label =
      instance.name && instance.name !== host ? `${host} — ${instance.name}` : host;

    const option = document.createElement("option");
    option.value = instance.id;
    // textContent, never markup: the name is user-typed and the host came off
    // the wire.
    option.textContent = ssl ? label : `${label} — SSL off`;
    option.disabled = !ssl;
    if (ssl) eligible.push(instance.id);
    select.appendChild(option);
  });

  if (eligible.length) {
    select.value = eligible.includes(preferredId) ? preferredId : eligible[0];
  }
  return eligible.length;
}

/**
 * Fill the saved-request picker from `_saved`.
 *
 * Names are user-typed and go in as `textContent`, never markup — the same rule
 * the profile chips are built under.
 */
function fillSaved(selectedId) {
  const select = el("replay-saved");
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = _saved.length ? "Saved requests…" : "Nothing saved yet";
  select.appendChild(placeholder);

  _saved.forEach((record) => {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = record.name;
    select.appendChild(option);
  });

  _savedId = _saved.some((r) => r.id === selectedId) ? selectedId : null;
  select.value = _savedId || "";
  el("btn-replay-delete-saved").disabled = !_savedId;
}

/** Refresh the saved list from the server. Never throws — an empty list is a
 *  fine answer, and a failure here must not stop the editor opening. */
async function refreshSaved(selectedId) {
  try {
    const res = await api("/__admin/saved-requests");
    const { requests } = res.ok ? await res.json() : {};
    _saved = Array.isArray(requests) ? requests : [];
  } catch {
    _saved = [];
  }
  fillSaved(selectedId);
}

// ── Schema files ─────────────────────────────────────────────────────────────
// The Expect pane holds a schema; `schemas/` holds the same schema as a file.
// The file is the one the CLI's `--schema-file` and CI read, so this pair of
// controls is what stops a check from existing only inside one saved request on
// one laptop. What moves in both directions is plain JSON Schema — no status,
// no wrapper — which is why the file can be pasted straight back into an API
// doc, or a schema pasted out of one saved without editing.

/** Fill the schemas/ picker. Silent on failure: it's a convenience, not a step. */
async function refreshSchemaFiles() {
  try {
    const res = await api("/__admin/schemas");
    const { schemas } = res.ok ? await res.json() : {};
    _schemaFiles = Array.isArray(schemas) ? schemas : [];
  } catch {
    _schemaFiles = [];
  }

  const select = el("replay-expect-file");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = _schemaFiles.length
    ? "Load from schemas/…"
    : "No schema files yet";
  select.appendChild(placeholder);
  // Titles come off disk and are editable by hand, so they are set as text.
  _schemaFiles.forEach((file) => {
    const option = document.createElement("option");
    option.value = file.id;
    option.textContent = file.title;
    select.appendChild(option);
  });
  select.value = "";
}

/**
 * Load a schema file into the pane, replacing what's there.
 *
 * The picker resets to its placeholder afterwards rather than staying on the
 * file: `change` doesn't fire for the option already selected, and re-picking
 * the same file is exactly how you throw away an edit you regret. The
 * provenance is kept in `_schemaFileId` instead, which is what makes Save
 * default to the name you loaded.
 */
export async function loadSchemaFile(id) {
  const select = el("replay-expect-file");
  select.value = "";
  if (!id) return;

  if (_expectEditor.getValue().trim()) {
    const ok = await showConfirm("Replace the schema in the editor with this file?");
    if (!ok) return;
  }

  try {
    const res = await api(`/__admin/schemas/${encodeURIComponent(id)}`);
    const payload = await res.json();
    if (!res.ok) return toast(payload.error || "Could not read that schema", "error");
    _expectEditor.setValue(JSON.stringify(payload.schema, null, 2), -1);
    _schemaFileId = id;
    setError("");
  } catch {
    toast("Could not read that schema", "error");
  }
}

/**
 * Write the schema in the pane to `schemas/`.
 *
 * The server runs it past the same `assertSupported` a send does before writing
 * anything, so a file saved from here cannot be one a run would refuse — the
 * refusal lands while you are still looking at the schema.
 */
export async function saveSchemaFile() {
  const parsed = readSchema();
  if (!parsed) return;
  if (!parsed.schema) {
    switchRequestTab("expect");
    return setError("There is no schema to save — the editor is empty.");
  }

  const loaded = _schemaFiles.find((f) => f.id === _schemaFileId);
  const suggested =
    loaded?.title ||
    (typeof parsed.schema.title === "string" ? parsed.schema.title : "") ||
    _saved.find((r) => r.id === _savedId)?.name ||
    "";

  const name = await showPrompt({
    title: "Save schema as file",
    label: "Name (becomes the filename in schemas/)",
    value: suggested,
    placeholder: "Order response",
    confirmLabel: "Save",
    validate: (v) => {
      if (!v) return "Give it a name.";
      if (v.length > 64) return "64 characters or fewer.";
      // A hint, not the rule: the server does the slugging and is the only
      // side that knows what the filename will be. Being wrong here costs a
      // warning that doesn't appear, never a file written somewhere else.
      const id = v
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      if (!id) return "Use at least one letter or digit.";
      if (id !== _schemaFileId && _schemaFiles.some((f) => f.id === id)) {
        return { warning: `Overwrites the existing ${id}.schema.json` };
      }
      return "";
    },
  });
  if (!name) return;

  try {
    const res = await api("/__admin/schemas", {
      method: "POST",
      body: { name, schema: parsed.schema },
    });
    const payload = await res.json();
    if (!res.ok) {
      switchRequestTab("expect");
      return setError(payload.error || "Could not save the schema.");
    }
    _schemaFileId = payload.id;
    setError("");
    toast(`Saved schemas/${payload.id}.schema.json`);
    refreshSchemaFiles();
  } catch {
    toast("Could not save the schema", "error");
  }
}

/** Swap the title, the target field and the send label for the current mode. */
function applyMode() {
  const compose = _mode === "compose";
  el("replay-title").textContent = compose ? "→ New Request" : "↻ Edit & Retry";
  // style.display, not `hidden`: these sit inside a styled note and any
  // `display` rule would win over the attribute.
  el("replay-host").style.display = compose ? "none" : "";
  el("replay-instance").style.display = compose ? "" : "none";
  // Compose-mode only: picking a saved request replaces every field, which
  // would silently throw away the capture Retry was opened to edit.
  el("replay-saved-group").style.display = compose ? "" : "none";
  el("btn-replay-send").textContent = compose ? "→ Send request" : "↻ Send request";
}

/**
 * Read what's in the editor, or explain why it can't be read.
 *
 * Shared by Send and Save so the two can't disagree about what the editor
 * contains — and so saving something unsendable is impossible.
 *
 * @returns {object|null} `{ method, path, headers, body, expect }`, or null
 *   with the error already on screen and the offending tab brought forward.
 */
function readFields() {
  const path = el("replay-path").value.trim();
  // `{{ base }}/orders` cannot start with "/" until it is resolved, and the
  // server re-checks the real rule on the resolved request — so the only thing
  // refusing it here would achieve is making it untypeable.
  if (!path.startsWith("/") && !path.startsWith("{{")) {
    setError('Path must start with "/" (or a {{ variable }}).');
    return null;
  }

  let headers;
  try {
    const raw = _headersEditor.getValue().trim();
    headers = raw ? JSON.parse(raw) : {};
    if (typeof headers !== "object" || Array.isArray(headers)) {
      throw new Error("Headers must be a JSON object.");
    }
  } catch (err) {
    switchRequestTab("headers");
    setError(`Headers: ${err.message}`);
    return null;
  }

  // The body is kept as-is when it isn't JSON — form-encoded and plain-text
  // payloads are just as sendable, and forcing JSON here would block them.
  const rawBody = _bodyEditor.getValue();
  let body = null;
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }

  const vars = readVariables();
  if (!vars) return null;

  const expectation = readExpect();
  if (!expectation) return null;

  return {
    method: el("replay-method").value,
    path,
    headers,
    body,
    ...vars,
    ...expectation,
  };
}

function show() {
  setError("");
  switchRequestTab("body");
  el("replay-modal").style.display = "flex";
  // Both modes come through here, so the picker is filled in one place.
  refreshSchemaFiles();
  // Ace measures itself on show; without this it renders zero-height.
  requestAnimationFrame(() => {
    _headersEditor.resize();
    _bodyEditor.resize();
    _varsEditor.resize();
    _expectEditor.resize();
    _bodyEditor.focus();
  });
}

/**
 * Open the editor pre-filled from a captured request.
 * @param {string} entryId
 */
export async function openReplayEditor(entryId) {
  const entry = state.allLogs.find((e) => e.id === entryId);
  if (!entry) return toast("That request is no longer in the log", "warning");

  try {
    await ensureAce();
  } catch (err) {
    return toast(err.message || "Failed to load the editor", "error");
  }

  ensureEditors();
  _mode = "replay";
  _entryId = entryId;
  _collectionId = null;
  // Kept so Save works from here too: the modal shows the host as text, but a
  // saved request is scoped by instance id like everything else.
  _instanceId = entry.instanceId || null;
  _savedId = null;

  fillMethods(entry.method);
  el("replay-path").value = entry.path || "/";
  el("replay-host").textContent = entry.host || "";

  // Hop-by-hop headers are recomputed by the server on send; showing them here
  // invites edits that are silently discarded.
  // Prefilled with the spellings the device used, so a Retry shows — and
  // re-sends — what was actually captured rather than Node's lowercase parse.
  const headers = withHeaderCase(entry.requestHeaders, entry.requestHeaderCase);
  // Matched case-insensitively: the keys above carry the device's spelling now,
  // so a captured `Content-Length` would survive a lowercase delete and come
  // back as an edit the server discards anyway.
  const hopByHop = new Set(["content-length", "connection", "proxy-connection", "host"]);
  Object.keys(headers).forEach((h) => {
    if (hopByHop.has(h.toLowerCase())) delete headers[h];
  });
  _headersEditor.setValue(JSON.stringify(headers, null, 2), -1);
  _bodyEditor.setValue(asText(entry.requestBody), -1);
  // A captured request has no expectation behind it — you are writing one now.
  fillVariables(null);
  fillExpect(null);

  applyMode();
  show();
}

/**
 * Open the editor empty, to compose a request from scratch.
 *
 * @param {object} [prefill] `{ instanceId, method, path, headers, body, expect }` — an
 *   instance makes the picker start on a chosen host. `savedId` additionally
 *   preselects a saved request in the list without loading it over the prefill,
 *   and `collectionId` is where a *newly named* save should land — set when the
 *   composer was opened from a collection, so saving doesn't drop the request
 *   into Ungrouped for the user to go and file by hand.
 */
export async function openComposer(prefill = {}) {
  try {
    await ensureAce();
  } catch (err) {
    return toast(err.message || "Failed to load the editor", "error");
  }

  ensureEditors();

  // Checked before anything is shown: an empty picker would be a dead end with
  // no way to explain itself.
  if (!fillInstances(prefill.instanceId)) {
    return toast(
      "No intercepted host yet — turn SSL proxying on for one from the tree first",
      "warning"
    );
  }

  _mode = "compose";
  _entryId = null;
  _instanceId = el("replay-instance").value;
  _collectionId = prefill.collectionId ?? null;
  // Set now as well as by the refresh below: the list arrives asynchronously,
  // and until it does the Save prompt would offer an empty name for something
  // that already has one.
  _savedId = prefill.savedId || null;

  fillMethods(prefill.method || "GET");
  el("replay-path").value = prefill.path || "/";
  _headersEditor.setValue(JSON.stringify(prefill.headers || {}, null, 2), -1);
  _bodyEditor.setValue(prefill.body ? asText(prefill.body) : "", -1);
  fillVariables(prefill.variables || null);
  fillExpect(prefill.expect || null);

  applyMode();
  show();
  // After show(), not before: the list is a nicety and the editor should be up
  // and usable whether or not the fetch lands.
  refreshSaved(prefill.savedId || null);
}

/**
 * Load a saved request into the editor.
 *
 * Always lands in compose mode — a saved request has no captured entry behind
 * it, so Retry's rules (fixed host, replay flag) don't apply to it.
 */
export function loadSavedRequest(id) {
  if (!id) {
    _savedId = null;
    el("btn-replay-delete-saved").disabled = true;
    return;
  }
  const record = _saved.find((r) => r.id === id);
  if (!record) return;

  _mode = "compose";
  _entryId = null;
  _savedId = id;
  // Picking a different saved request out of the list means you are now editing
  // something that already has a home. Carrying the previous collection across
  // would file it somewhere it was never asked to go.
  _collectionId = null;

  const stillThere = fillInstances(record.instanceId);
  const instanceSelect = el("replay-instance");
  fillMethods(record.method || "GET");
  el("replay-path").value = record.path || "/";
  _headersEditor.setValue(JSON.stringify(record.headers || {}, null, 2), -1);
  _bodyEditor.setValue(record.body == null ? "" : asText(record.body), -1);
  fillVariables(record.variables);
  fillExpect(record.expect);

  applyMode();
  el("btn-replay-delete-saved").disabled = false;

  // The instance it was saved for can be gone, renamed, or have had SSL turned
  // off since. Say so rather than quietly sending somewhere else.
  if (stillThere && instanceSelect.value !== record.instanceId) {
    setError(
      `Saved for "${record.instanceId}", which isn't available — the target above is where this will go.`
    );
  } else {
    setError("");
  }
  switchRequestTab("body");
}

export function closeRequestEditor() {
  const modal = el("replay-modal");
  if (modal) modal.style.display = "none";
  _entryId = null;
  _savedId = null;
  _collectionId = null;
}

export function switchRequestTab(tab) {
  ["headers", "body", "variables", "expect"].forEach((name) => {
    const isActive = name === tab;
    const pane = el(`replay-pane-${name}`);
    if (pane) pane.hidden = !isActive;
    const btn = el(`replay-tab-${name}`);
    if (btn) {
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
    }
  });
  const editor =
    { headers: _headersEditor, variables: _varsEditor, expect: _expectEditor }[tab] ||
    _bodyEditor;
  requestAnimationFrame(() => editor?.resize());
}

/** Send whatever is in the editor. Validation failures stay in the modal. */
export async function sendRequestEdit() {
  if (_mode === "replay" && !_entryId) return;

  const fields = readFields();
  if (!fields) return;

  setError("");
  const button = el("btn-replay-send");
  button.disabled = true;
  try {
    // `expect` is a question about the answer, not an edit to the request, so
    // a replay carries it beside its overrides rather than inside them.
    const { expect: expectation, variables, ...request } = fields;
    const {
      ok,
      error,
      expect: verdict,
    } = _mode === "compose"
      ? await sendComposed({
          instanceId: el("replay-instance").value,
          ...request,
          ...(expectation ? { expect: expectation } : {}),
          ...(variables ? { variables } : {}),
        })
      : await replayEntry(_entryId, request, expectation, variables);

    if (ok && verdict && !verdict.passed) {
      // Closing here would throw away the one thing you sent it to find out.
      // The error box is exactly where this belongs: something you fix while
      // still looking at the editor.
      switchRequestTab("expect");
      setError(
        `The request went out and came back — the response failed its check:\n` +
          verdict.errors.join("\n")
      );
      return;
    }
    if (ok) {
      // Variables are the one thing a Send writes back. They are the request's
      // inputs, not a one-off edit to its content — the reason to put a value in
      // that tab instead of inline in the path is so it stays, and one that
      // evaporated on every Send would make the tab useful only to whoever
      // remembered to press Save afterwards. Path and body edits still don't
      // persist, which is what Save is for.
      if (_savedId) await persistVariables(_savedId, variables);
      return closeRequestEditor();
    }
    // Keep the reason on screen. A rejected send used to leave the modal
    // sitting there unchanged, which reads as "the Send button does nothing".
    setError(error || "The proxy rejected this request.");
  } catch (err) {
    setError(err.message || "Something went wrong sending the request.");
  } finally {
    button.disabled = false;
  }
}

/**
 * Write a Send's variables back to the saved request they came from.
 *
 * Best-effort and silent on failure: the request went out, which is what the
 * button promised, and a toast about bookkeeping would bury that.
 */
async function persistVariables(id, variables) {
  const stored = _saved.find((r) => r.id === id)?.variables ?? null;
  const next = variables ?? null;
  if (JSON.stringify(stored) === JSON.stringify(next)) return;

  try {
    await api(`/__admin/saved-requests/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { variables: next },
    });
    await refreshSaved(id);
  } catch (err) {
    // The send is what mattered, so this never becomes a toast — but silence
    // with no trace at all is how a broken write goes unnoticed for weeks.
    console.error("Could not persist variables", err);
  }
}

/**
 * Keep the current request under a name.
 *
 * Works from both modes: saving an edited capture is how "this is the login
 * call, I'll want it again" gets recorded. The instance is the picked one in
 * compose mode and the captured one in replay mode — either way a saved
 * request is scoped by instance id, never by hostname.
 */
export async function saveCurrentRequest() {
  const fields = readFields();
  if (!fields) return;

  const instanceId = _mode === "compose" ? el("replay-instance").value : _instanceId;
  if (!instanceId) {
    setError("This request has no instance to save it against.");
    return;
  }

  const current = _saved.find((r) => r.id === _savedId);
  const name = await showPrompt({
    title: "Save request",
    label: "Name",
    value: current?.name || "",
    placeholder: "e.g. Login as QA user",
    confirmLabel: "Save",
    // Mirrors validateName on the server. Returning `{ warning }` rather than a
    // string for an existing name is the point: overwriting one deliberately is
    // a legitimate thing to want.
    validate: (value) => {
      if (!value) return "Give it a name.";
      if (value.length > 64) return "64 characters or fewer.";
      if (/[<>&"'`]/.test(value)) return "Can't contain < > & \" ' `";
      if (_saved.some((r) => r.name === value && r.id !== _savedId)) {
        return { warning: "A saved request with this name will be replaced." };
      }
      return "";
    },
  });
  if (name === null) return; // cancelled

  const button = el("btn-replay-save");
  button.disabled = true;
  try {
    const res = await api("/__admin/saved-requests", {
      method: "POST",
      body: { name, instanceId, collectionId: _collectionId, ...fields },
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      setError(error || `Could not save (HTTP ${res.status})`);
      return;
    }
    const { request: saved } = await res.json();
    setError("");
    toast(`Saved "${saved.name}"`, "success");
    await refreshSaved(saved.id);
    // The collections screen may be the thing behind this modal. Up through
    // `window`, like every other cross-module call here, to stay acyclic.
    window.refreshCollections?.();
  } catch (err) {
    setError(err.message || "Could not reach the proxy");
  } finally {
    button.disabled = false;
  }
}

/** Delete the saved request currently loaded in the picker. */
export async function deleteSavedRequest() {
  const record = _saved.find((r) => r.id === _savedId);
  if (!record) return;

  if (!(await showConfirm(`Delete the saved request "${record.name}"?`))) return;

  try {
    const res = await api(`/__admin/saved-requests/${encodeURIComponent(record.id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      setError(error || `Could not delete (HTTP ${res.status})`);
      return;
    }
    toast(`Deleted "${record.name}"`, "success");
    // The fields stay as they are — you may well have just deleted the saved
    // copy of something you still want to send.
    await refreshSaved(null);
    window.refreshCollections?.();
  } catch (err) {
    setError(err.message || "Could not reach the proxy");
  }
}

/** Is the modal open? (used by the Esc cascade) */
export function isRequestEditorOpen() {
  return el("replay-modal")?.style.display === "flex";
}
