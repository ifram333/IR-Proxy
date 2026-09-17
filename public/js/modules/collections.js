/**
 * collections.js — saved requests, grouped and runnable.
 *
 * A third full-pane view alongside traffic and the mock matrix
 * (`state.inspectorMode`), and the answer to "where did I put that request?":
 * every saved request on one screen, in named groups, each one sendable on the
 * spot and each group runnable **in order**.
 *
 * Order is why a collection is a list and not a tag. "Log in, then call the
 * thing that needs the token" is the shape these have, so `Run all` walks the
 * group top to bottom, **one request at a time**, waiting for each before
 * starting the next. Firing them in parallel would be faster and would answer a
 * different question.
 *
 * The run happens **here, not on the server**, and each step is an ordinary
 * `POST /__admin/send`. That means it inherits everything that route already
 * guarantees — the target host comes from the instance, SSL-off is a 409 you
 * can read, the call lands in the activity log next to the device traffic — and
 * it means progress shows up row by row and stopping is a local flag rather
 * than server state nobody is watching. A run does not survive closing the tab,
 * which is the honest behaviour for something with a Stop button.
 *
 * Rows are **real DOM with a delegated listener**, like the tree and the
 * inspector and unlike the mock matrix: request names and paths are typed by a
 * user and go in as `textContent`, never interpolated into markup.
 *
 * Dragging is the same native HTML5 drag the mock matrix uses to move a mock
 * into a folder, with one extra dimension: a mock only needs a destination
 * folder, a request needs a destination **and a position**, because the order is
 * what a run follows. Both end at the same `assign` call.
 */
import { state } from "./state.js";
import { api, toast, showPrompt, showConfirm, escapeHtml } from "./util.js";
import { openContextMenu } from "./contextmenu.js";
import { openComposer } from "./request-editor.js";

const COLLAPSED_KEY = "ir-proxy.collections.collapsed";

/** Last `/collections` response: `{ collections: [...], ungrouped: [...] }`. */
let _data = { collections: [], ungrouped: [] };
let _query = "";
let _collapsed = new Set();

/** requestId → `{ phase, status?, ms?, error? }` for the run in progress. */
const _run = new Map();
/** The token of the running batch, or null. `aborted` is how Stop is heard. */
let _batch = null;

const el = (id) => document.getElementById(id);

// ── Loading ──────────────────────────────────────────────────────

/** Pull the screen's data and repaint. Never throws — an empty screen says so. */
export async function refreshCollections() {
  try {
    const res = await api("/__admin/collections");
    const body = res.ok ? await res.json() : null;
    _data = {
      collections: Array.isArray(body?.collections) ? body.collections : [],
      ungrouped: Array.isArray(body?.ungrouped) ? body.ungrouped : [],
    };
  } catch {
    _data = { collections: [], ungrouped: [] };
  }
  if (state.inspectorMode === "requests") renderCollections();
}

export function openCollections() {
  state.inspectorMode = "requests";
  window.closeSettings?.();
  window.render?.();
  refreshCollections();
}

export function closeCollections() {
  state.inspectorMode = "traffic";
  window.render?.();
}

export function handleCollectionSearch(value) {
  _query = String(value || "")
    .trim()
    .toLowerCase();
  renderCollections();
}

// ── Collapse memory ──────────────────────────────────────────────

function loadCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    _collapsed = new Set(Array.isArray(saved) ? saved : []);
  } catch {
    _collapsed = new Set();
  }
}

function persistCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([..._collapsed]));
  } catch {
    // Private mode or full storage: it folded, it just won't remember.
  }
}

// ── Rendering ────────────────────────────────────────────────────

const matches = (record) =>
  !_query ||
  record.name.toLowerCase().includes(_query) ||
  String(record.path || "")
    .toLowerCase()
    .includes(_query);

/**
 * Every group on screen, ungrouped last — it is a leftover, not a peer.
 *
 * Shown even when empty, because it is a **drop target**: dragging a request out
 * of a collection needs somewhere to land, and hiding the only place it can go
 * turns the obvious gesture into a dead end. Its empty text says as much.
 */
function groups() {
  return [
    ..._data.collections.map((c) => ({ ...c, ungrouped: false })),
    { id: null, name: "Ungrouped", requests: _data.ungrouped, ungrouped: true },
  ];
}

function row(record, group) {
  const node = document.createElement("div");
  node.className = "coll-row";
  node.dataset.request = record.id;
  if (group.id) node.dataset.collection = group.id;
  node.tabIndex = 0;
  node.draggable = true;
  node.title = "Open in the request editor — drag to reorder or regroup";

  const method = document.createElement("span");
  method.className = `coll-method ${record.method || "GET"}`;
  method.textContent = record.method || "GET";

  const name = document.createElement("span");
  name.className = "coll-req-name";
  name.textContent = record.name;

  // Which rows are actually checked has to be visible without opening each
  // one: a green run of requests that assert nothing is the thing this whole
  // feature exists to stop being mistaken for a passing suite.
  if (record.expect) {
    const mark = document.createElement("span");
    mark.className = "coll-expect-mark";
    mark.textContent = "{ }";
    mark.title = [
      record.expect.status ? `Expects status ${record.expect.status}` : null,
      record.expect.schema ? "Checks the response body against a schema" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    name.appendChild(mark);
  }

  const path = document.createElement("span");
  path.className = "coll-path";
  path.textContent = record.path || "/";

  const instance = document.createElement("span");
  instance.className = "coll-instance";
  instance.textContent = record.instanceId || "—";

  const status = document.createElement("span");
  status.className = "coll-status";

  const send = document.createElement("button");
  send.className = "btn btn-ghost btn-icon coll-send";
  send.dataset.action = "run-request";
  send.title = "Send this request through the proxy";
  send.textContent = "▷";

  node.append(method, name, path, instance, status, send);
  paintStatus(node, _run.get(record.id));
  return node;
}

function groupNode(group) {
  const section = document.createElement("section");
  section.className = "coll-group";
  if (group.id) section.dataset.collection = group.id;

  const visible = group.requests.filter(matches);
  const collapsed = group.id ? _collapsed.has(group.id) : false;

  const head = document.createElement("header");
  head.className = "coll-group-head";
  head.dataset.action = "toggle";
  if (group.id) head.dataset.collection = group.id;
  if (group.ungrouped) head.classList.add("is-ungrouped");

  const twisty = document.createElement("span");
  twisty.className = "coll-twisty";
  twisty.textContent = group.id ? (collapsed ? "▸" : "▾") : "";

  const name = document.createElement("span");
  name.className = "coll-group-name";
  name.textContent = group.name;

  const count = document.createElement("span");
  count.className = "coll-badge";
  count.textContent = String(group.requests.length);

  head.append(twisty, name, count);

  if (!group.ungrouped) {
    const hint = document.createElement("span");
    hint.className = "coll-hint";
    hint.textContent = "right-click for options";
    head.appendChild(hint);

    const run = document.createElement("button");
    run.className = "btn btn-ghost btn-icon";
    run.dataset.action = "run-collection";
    run.title = "Send every request in this collection, in order";
    run.textContent = "▷▷";
    run.disabled = !group.requests.length;

    const add = document.createElement("button");
    add.className = "btn btn-ghost btn-icon";
    add.dataset.action = "new-in";
    add.title = "Compose a request and save it into this collection";
    add.textContent = "＋";

    head.append(run, add);
  }

  section.appendChild(head);

  if (!collapsed) {
    const rows = document.createElement("div");
    rows.className = "coll-rows";
    if (visible.length) {
      visible.forEach((record) => rows.appendChild(row(record, group)));
    } else {
      const empty = document.createElement("div");
      empty.className = "coll-empty-row";
      empty.textContent = group.requests.length
        ? "Nothing here matches the filter."
        : group.ungrouped
          ? "Every saved request is in a collection."
          : "Empty — compose one here, or move one in from another group.";
      rows.appendChild(empty);
    }
    section.appendChild(rows);
  }

  return section;
}

/** Repaint the whole screen from the last fetch. */
export function renderCollections() {
  const list = el("coll-list");
  if (!list) return;

  const all = [..._data.collections.flatMap((c) => c.requests), ..._data.ungrouped];
  const shown = all.filter(matches).length;

  el("coll-sub").textContent = _data.collections.length
    ? `${_data.collections.length} collection${_data.collections.length === 1 ? "" : "s"} · ${all.length} saved request${all.length === 1 ? "" : "s"}`
    : "Saved requests, grouped and runnable in order";
  el("coll-count").textContent = _query ? `${shown} of ${all.length} shown` : "";

  if (!all.length && !_data.collections.length) {
    list.innerHTML = `<div class="coll-blank">
        <p>Nothing saved yet.</p>
        <p class="coll-blank-hint">
          Compose a request with <strong>${escapeHtml("→ New request")}</strong>, then
          <strong>Save</strong> it under a name. It shows up here, ready to run.
        </p>
      </div>`;
    return;
  }

  list.replaceChildren(...groups().map(groupNode));
}

// ── Run status ───────────────────────────────────────────────────

/**
 * Paint one row's status cell.
 *
 * Targeted rather than a full repaint: a run touches one row at a time, and
 * rebuilding the list under the reader every couple of seconds would throw away
 * their scroll position and any menu they had open.
 */
function paintStatus(node, run) {
  const cell = node?.querySelector(".coll-status");
  if (!cell) return;
  cell.className = "coll-status";
  cell.removeAttribute("title");

  if (!run) return void (cell.textContent = "");
  if (run.phase === "queued") {
    cell.textContent = "·";
    return cell.classList.add("is-queued");
  }
  if (run.phase === "running") {
    cell.textContent = "…";
    return cell.classList.add("is-running");
  }
  if (run.phase === "failed") {
    cell.textContent = "✕";
    cell.title = run.error || "Failed";
    return cell.classList.add("is-err");
  }
  // A response that failed its check is not a failed *send* — the status stays
  // on screen and the mark sits beside it, because "500" and "200 that was the
  // wrong shape" are different findings and the row has to say which.
  const verdict = run.expect ? (run.expect.passed ? " ✓" : " ✗") : "";
  cell.textContent = `${run.status}${verdict}${run.ms == null ? "" : ` · ${run.ms} ms`}`;
  if (run.expect && !run.expect.passed) {
    cell.title = run.expect.errors.join("\n");
    return cell.classList.add("is-err");
  }
  cell.classList.add(
    run.status < 300 ? "is-ok" : run.status < 500 ? "is-warn" : "is-err"
  );
}

function setRun(id, run) {
  if (run) _run.set(id, run);
  else _run.delete(id);
  paintStatus(el("coll-list")?.querySelector(`[data-request="${CSS.escape(id)}"]`), run);
}

// ── Running ──────────────────────────────────────────────────────

/**
 * Send one saved request.
 *
 * **By id**, not by re-assembling the record here: `/saved-requests/:id/send`
 * is the one place that knows what a saved request becomes on the wire, and
 * this screen is only one of four things that need it — the CLI and the three
 * drop-in clients are the others. Building the payload here again is how a
 * field added to a saved request quietly stops being sent by everything except
 * whichever copy somebody remembered to update.
 *
 * The run itself stays here, because order, progress and Stop belong to the
 * thing watching them.
 *
 * Resolves to true when the proxy answered 2xx **and** the response met the
 * request's expectation, if it had one.
 */
async function send(record) {
  setRun(record.id, { phase: "running" });
  const started = performance.now();
  try {
    const res = await api(
      `/__admin/saved-requests/${encodeURIComponent(record.id)}/send`,
      { method: "POST", body: {} }
    );
    const payload = await res.json().catch(() => ({}));
    const ms = Math.round(performance.now() - started);

    if (!res.ok) {
      // The reasons that land here are the readable ones — SSL off for the
      // target (409), instance gone (404) — so the message is worth keeping.
      setRun(record.id, {
        phase: "failed",
        error: payload.error || `HTTP ${res.status}`,
      });
      return false;
    }
    setRun(record.id, {
      phase: "done",
      status: payload.status,
      ms,
      expect: payload.expect,
    });
    // A response that failed its check counts against the run: a summary that
    // said "8 ok" while half of them came back the wrong shape would be the
    // one number nobody could trust.
    return payload.status < 400 && payload.expect?.passed !== false;
  } catch (err) {
    setRun(record.id, {
      phase: "failed",
      error: err.message || "Could not reach the proxy",
    });
    return false;
  }
}

/**
 * Send a list of requests, one after another.
 *
 * Sequential and **not** stop-on-first-failure: a run is how you find out where
 * a flow breaks, and the rows after the red one are part of that answer. Stop
 * is there for when you have seen enough.
 */
async function runBatch(records, label) {
  if (_batch) return toast("A run is already going", "warning");
  if (!records.length) return;

  const token = { aborted: false };
  _batch = token;
  el("btn-coll-stop").hidden = false;

  records.forEach((record) => setRun(record.id, { phase: "queued" }));

  let ok = 0;
  let ran = 0;
  for (const record of records) {
    if (token.aborted) {
      setRun(record.id, null);
      continue;
    }
    ran++;
    if (await send(record)) ok++;
  }

  _batch = null;
  el("btn-coll-stop").hidden = true;

  const failed = ran - ok;
  const summary = `${label}: ${ran} sent, ${ok} ok${failed ? `, ${failed} failed` : ""}${
    token.aborted ? " (stopped)" : ""
  }`;
  toast(summary, failed ? "warning" : "success");
}

/** Stop after the request currently in flight — it is already on the wire. */
export function stopRun() {
  if (!_batch) return;
  _batch.aborted = true;
  toast("Stopping after the request in flight…", "info");
}

// ── Lookups ──────────────────────────────────────────────────────

function findRequest(id) {
  for (const group of groups()) {
    const record = group.requests.find((r) => r.id === id);
    if (record) return { record, group };
  }
  return null;
}

// ── Actions ──────────────────────────────────────────────────────

/** Names go through the same rules the server enforces, one keystroke early. */
const nameValidator = (existing, currentId) => (value) => {
  if (!value) return "Give it a name.";
  if (value.length > 64) return "64 characters or fewer.";
  if (/[<>&"'`]/.test(value)) return "Can't contain < > & \" ' `";
  if (existing.some((c) => c.name === value && c.id !== currentId)) {
    return { warning: "Another collection already has this name." };
  }
  return "";
};

export async function createCollection() {
  const name = await showPrompt({
    title: "New collection",
    label: "Name",
    placeholder: "e.g. Checkout flow",
    confirmLabel: "Create",
    validate: nameValidator(_data.collections, null),
  });
  if (name === null) return;

  const res = await api("/__admin/collections", { method: "POST", body: { name } });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    return toast(error || `Could not create it (HTTP ${res.status})`, "error");
  }
  await refreshCollections();
  toast(`Created "${name}"`, "success");
}

async function renameCollection(collection) {
  const name = await showPrompt({
    title: "Rename collection",
    label: "Name",
    value: collection.name,
    confirmLabel: "Rename",
    validate: nameValidator(_data.collections, collection.id),
  });
  if (name === null || name === collection.name) return;

  const res = await api(`/__admin/collections/${encodeURIComponent(collection.id)}`, {
    method: "PATCH",
    body: { name },
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    return toast(error || `Could not rename it (HTTP ${res.status})`, "error");
  }
  await refreshCollections();
}

async function deleteCollection(collection) {
  // Said plainly, because "delete the folder" reads like "delete what's in it".
  const kept = collection.requests.length
    ? ` Its ${collection.requests.length} request${collection.requests.length === 1 ? "" : "s"} will be kept, ungrouped.`
    : "";
  if (!(await showConfirm(`Delete the collection "${collection.name}"?${kept}`))) return;

  const res = await api(`/__admin/collections/${encodeURIComponent(collection.id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    return toast(error || `Could not delete it (HTTP ${res.status})`, "error");
  }
  _collapsed.delete(collection.id);
  persistCollapsed();
  await refreshCollections();
}

async function assign(requestId, collectionId, index) {
  const res = await api("/__admin/collections/assign", {
    method: "POST",
    body: { requestId, collectionId, index },
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    return toast(error || `Could not move it (HTTP ${res.status})`, "error");
  }
  await refreshCollections();
}

async function deleteRequest(record) {
  if (!(await showConfirm(`Delete the saved request "${record.name}"?`))) return;
  const res = await api(`/__admin/saved-requests/${encodeURIComponent(record.id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    return toast(error || `Could not delete it (HTTP ${res.status})`, "error");
  }
  setRun(record.id, null);
  await refreshCollections();
  toast(`Deleted "${record.name}"`, "success");
}

/**
 * Open one in the request editor, with the collection it came from in hand.
 *
 * The record is **spread**, not enumerated field by field. It used to be a
 * hand-written list — instanceId, method, path, headers, body, expect — and
 * `variables` was added to a saved request long after that list was written, so
 * opening a request from here showed an empty Variables pane and saving from
 * there wiped what was stored. The stored shape and this prefill are the same
 * shape; writing it out twice is how they come apart, and the next field added
 * would have gone the same way.
 *
 * Only the identity and the bookkeeping are peeled off: `id` becomes `savedId`,
 * and `name`/`savedAt` describe the file rather than the request.
 */
function openInEditor(record, group) {
  const { id, name, savedAt, ...fields } = record;
  openComposer({ ...fields, savedId: id, collectionId: group?.id || null });
}

// ── Menus ────────────────────────────────────────────────────────

function requestMenuItems(record, group) {
  const position = group.requests.indexOf(record);
  const inCollection = Boolean(group.id);

  const items = [
    { heading: `${record.method || "GET"} ${String(record.path || "/").split("?")[0]}` },
    { label: "Open in the request editor", onSelect: () => openInEditor(record, group) },
    {
      label: "Send it now",
      hint: "through the proxy",
      onSelect: () => runBatch([record], record.name),
    },
  ];

  if (inCollection) {
    items.push(
      { separator: true },
      {
        label: "Move up",
        disabled: position <= 0,
        onSelect: () => assign(record.id, group.id, position - 1),
      },
      {
        label: "Move down",
        disabled: position < 0 || position >= group.requests.length - 1,
        onSelect: () => assign(record.id, group.id, position + 1),
      }
    );
  }

  items.push({ separator: true }, { heading: "Move to" });
  _data.collections.forEach((collection) => {
    items.push({
      label: collection.name,
      checked: collection.id === group.id,
      disabled: collection.id === group.id,
      onSelect: () => assign(record.id, collection.id),
    });
  });
  items.push({
    label: "Ungrouped",
    checked: !inCollection,
    disabled: !inCollection,
    onSelect: () => assign(record.id, null),
  });

  items.push(
    { separator: true },
    { label: "Delete this request", danger: true, onSelect: () => deleteRequest(record) }
  );
  return items;
}

function groupMenuItems(group) {
  return [
    { heading: group.name },
    {
      label: "Run every request, in order",
      disabled: !group.requests.length,
      onSelect: () => runBatch(group.requests, group.name),
    },
    {
      label: "New request here",
      onSelect: () => openComposer({ collectionId: group.id }),
    },
    { separator: true },
    { label: "Rename…", onSelect: () => renameCollection(group) },
    {
      label: "Delete this collection",
      hint: "requests are kept",
      danger: true,
      onSelect: () => deleteCollection(group),
    },
  ];
}

// ── Wiring ───────────────────────────────────────────────────────

// ── Dragging ─────────────────────────────────────────────────────
// Native HTML5 drag, as the mock matrix uses. What a request needs that a mock
// file doesn't is a **position**: dropping on the top half of a row means
// "before it", the bottom half means "after it", and dropping anywhere else in
// a group appends. All three end at the same `assign`.

let _dragging = null; // id of the request being dragged

/** Clear every drag decoration, wherever the drag ended. */
function clearDropMarks() {
  el("coll-list")
    ?.querySelectorAll(".drop-before, .drop-after, .drag-over, .dragging")
    .forEach((node) =>
      node.classList.remove("drop-before", "drop-after", "drag-over", "dragging")
    );
}

/**
 * Where would a drop at this point land?
 *
 * @returns {{collectionId: string|null, index: number|null, row: Element|null,
 *   half: "before"|"after"|null}|null} null when the point is outside any group
 */
function dropTarget(event) {
  const section = event.target.closest?.(".coll-group");
  if (!section) return null;
  const collectionId = section.dataset.collection || null;

  const row = event.target.closest(".coll-row");
  if (!row) return { collectionId, index: null, row: null, half: null };

  const rect = row.getBoundingClientRect();
  const half = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  const siblings = [...section.querySelectorAll(".coll-row")];
  const position = siblings.indexOf(row);
  return {
    collectionId,
    index: half === "before" ? position : position + 1,
    row,
    half,
  };
}

function handleDragStart(event) {
  const row = event.target.closest(".coll-row");
  if (!row) return;
  _dragging = row.dataset.request;
  // text/plain so the drag has a payload at all — some browsers refuse to start
  // one without it. The id we actually act on is the module-level `_dragging`,
  // because dataTransfer is unreadable during dragover, which is where the
  // insertion marker has to be decided.
  event.dataTransfer.setData("text/plain", _dragging);
  event.dataTransfer.effectAllowed = "move";
  row.classList.add("dragging");
}

function handleDragOver(event) {
  if (!_dragging) return;
  const target = dropTarget(event);
  if (!target) return;
  event.preventDefault(); // this is what makes the area droppable at all
  event.dataTransfer.dropEffect = "move";

  clearDropMarks();
  el("coll-list")
    ?.querySelector(`[data-request="${CSS.escape(_dragging)}"]`)
    ?.classList.add("dragging");

  if (target.row) target.row.classList.add(`drop-${target.half}`);
  else event.target.closest(".coll-group")?.classList.add("drag-over");
}

async function handleDrop(event) {
  if (!_dragging) return;
  const target = dropTarget(event);
  const id = _dragging;
  _dragging = null;
  clearDropMarks();
  if (!target) return;
  event.preventDefault();

  const found = findRequest(id);
  if (!found) return;

  let index = target.index;
  // `assign` takes the request out before putting it back, so an index measured
  // against the list *with* it still in is one too high when it is moving down
  // inside its own group. Correcting it here rather than in the store keeps that
  // contract — "remove, then place at index" — simple and testable.
  if (index != null && found.group.id === target.collectionId) {
    const from = found.group.requests.indexOf(found.record);
    if (from > -1 && from < index) index -= 1;
    if (from === index) return; // dropped where it already is
  }

  await assign(id, target.collectionId, index ?? undefined);
}

function toggleGroup(id) {
  if (!id) return;
  if (_collapsed.has(id)) _collapsed.delete(id);
  else _collapsed.add(id);
  persistCollapsed();
  renderCollections();
}

/**
 * One delegated listener per event, on the list root: the whole list is rebuilt
 * on every change, so per-element handlers would need re-attaching each time.
 */
export function initCollections() {
  loadCollapsed();

  const list = el("coll-list");
  if (!list) return;

  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button) {
      const head = button.closest(".coll-group-head");
      const rowNode = button.closest(".coll-row");
      const group = groups().find((g) => g.id === (head || rowNode)?.dataset.collection);

      if (button.dataset.action === "run-collection" && group) {
        return runBatch(group.requests, group.name);
      }
      if (button.dataset.action === "new-in" && group) {
        return openComposer({ collectionId: group.id });
      }
      if (button.dataset.action === "run-request" && rowNode) {
        const found = findRequest(rowNode.dataset.request);
        if (found) return runBatch([found.record], found.record.name);
      }
      return;
    }

    const head = event.target.closest(".coll-group-head");
    if (head) return toggleGroup(head.dataset.collection);

    const rowNode = event.target.closest(".coll-row");
    if (!rowNode) return;
    const found = findRequest(rowNode.dataset.request);
    if (found) openInEditor(found.record, found.group);
  });

  list.addEventListener("contextmenu", (event) => {
    const rowNode = event.target.closest(".coll-row");
    if (rowNode) {
      const found = findRequest(rowNode.dataset.request);
      if (found)
        return openContextMenu(event, requestMenuItems(found.record, found.group));
    }
    const head = event.target.closest(".coll-group-head");
    if (!head?.dataset.collection) return;
    const group = groups().find((g) => g.id === head.dataset.collection);
    if (group) openContextMenu(event, groupMenuItems(group));
  });

  list.addEventListener("dragstart", handleDragStart);
  list.addEventListener("dragover", handleDragOver);
  list.addEventListener("drop", handleDrop);
  // Both endings, because a cancelled drag fires only `dragend` — the mock
  // matrix has no such handler, which is why a cancelled drag there leaves the
  // row faded until the next repaint.
  list.addEventListener("dragend", () => {
    _dragging = null;
    clearDropMarks();
  });
  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget)) clearDropMarks();
  });

  list.addEventListener("keydown", (event) => {
    const rowNode = event.target.closest?.(".coll-row");
    if (!rowNode || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    const found = findRequest(rowNode.dataset.request);
    if (found) openInEditor(found.record, found.group);
  });
}
