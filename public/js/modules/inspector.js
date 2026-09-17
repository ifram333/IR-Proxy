/**
 * inspector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The right panel.
 *
 * Two stacked regions, split by a draggable divider:
 *   • top — every call under the selected node, newest first. Selecting a host
 *     or a folder shows its whole subtree, which is how you inspect an API
 *     surface rather than one endpoint.
 *   • bottom — the chosen call: method, status, duration, source, path, then
 *     Request (query, headers, body) and Response (headers, body) as tabs.
 *
 * Request and Response are tabs rather than side-by-side columns: at the widths
 * this panel actually gets, one full-width JSON column reads far better than
 * two half-width ones.
 *
 * The detail rendering, in-panel search, copy, copy-as-cURL and
 * create-mock-from-request behaviour is carried over from the old detail modal
 * — it was the good part of that screen and it works.
 */
import { state, srcLabelFor } from "./state.js";
import { api, toast, fmtTime, copyText, showPrompt, withHeaderCase } from "./util.js";
import { ensureEditor, validateMockPath } from "./editor.js";
import { renderValue } from "./jsontree.js";
import { collectEntries } from "./tree-model.js";
import { selectedNode } from "./hosts.js";
import { replayEntry, clearEntries, replayability } from "./entries.js";
import { openContextMenu } from "./contextmenu.js";
import {
  configureSearch,
  resetSearch,
  loadSearchPrefs,
  rescopeSearch,
} from "./panel-search.js";

let _activeTab = "request";
// Which sub-tab each panel is showing. Carried across entries — reading a field
// down a list of calls means comparing the *same* field, so throwing you back to
// Request/Body on every click made the list unusable.
let _activeSubTab = { request: "req-body", response: "res-body" };
// The request currently drawn in the detail pane, so a re-render caused by
// unrelated live traffic doesn't reset the reader's tab, sub-tab and search.
let _renderedEntryId = null;

// ── Helpers ──────────────────────────────────────────────────────

const el = (id) => document.getElementById(id);

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** The host record behind the selected node, if we know it. */
function hostRecordFor(node) {
  return state.hosts.find((h) => h.host === node?.host) || null;
}

// ── Overview (host / folder selection) ───────────────────────────

function renderOverview(node) {
  const record = hostRecordFor(node);
  const instance = state.cachedData?.instances?.find(
    (i) => i.id === (record?.instanceId || null)
  );

  const rows = [
    ["Host", node.host],
    ["Port", (record?.ports || []).join(", ") || "—"],
    ["Protocol", (record?.protocols || []).join(", ").toUpperCase() || "—"],
    ["Path", node.kind === "host" ? "/" : node.path],
    ["SSL proxying", record?.ssl ? "On — traffic is decrypted" : "Off — tunneled"],
    // Not "Upstream": this is the URL being *intercepted*, which since the
    // upstream became editable is no longer necessarily where traffic goes. The
    // forwarding destination is the editable control further down.
    ["Intercepting", instance?.target || "—"],
    [
      node.kind === "host" && !record?.ssl ? "Connections" : "Requests",
      String(node.kind === "host" && !record?.ssl ? record?.connections || 0 : node.hits),
    ],
    ["Errors", String(node.errors || 0)],
    ["First seen", record?.firstSeen ? new Date(record.firstSeen).toLocaleString() : "—"],
    ["Last seen", record?.lastSeen ? new Date(record.lastSeen).toLocaleString() : "—"],
  ];

  const grid = document.createElement("dl");
  grid.className = "ov-grid";
  rows.forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    grid.append(dt, dd);
  });

  const wrap = document.createElement("div");
  wrap.className = "ov";

  const title = document.createElement("h2");
  title.className = "ov-title";
  title.textContent = node.kind === "host" ? node.host : node.path;
  wrap.appendChild(title);

  // The single most useful thing to say on this screen: a host that isn't
  // decrypted will never run a mock, and that's invisible otherwise.
  if (record && !record.ssl) {
    const banner = document.createElement("div");
    banner.className = "ov-banner warn";
    banner.textContent =
      "SSL proxying is off for this host — its traffic is tunneled, so no requests are logged and no mocks run. Right-click the host to enable it.";
    wrap.appendChild(banner);
  }

  wrap.appendChild(grid);

  // Per-host controls live here now that the instance cards are gone. Only
  // hosts that have been promoted to an instance have anything to control.
  if (node.kind === "host" && record?.instanceId) {
    wrap.appendChild(renderHostControls(record, instance));
  }

  return wrap;
}

/**
 * The switches that used to live on an instance card.
 *
 * `isActive` is the one to be careful with. Turning it OFF does not stop the
 * proxy touching the host — it still decrypts and then answers every request
 * with `503`. That is the opposite of what "off" means one row above, where
 * SSL proxying off means "leave this host alone entirely". Two adjacent
 * switches both labelled "off" meaning opposite things is a support ticket, so
 * this one is labelled by its effect rather than its field name. The API field
 * keeps the name `isActive`.
 */
function renderHostControls(record, instance) {
  const settings = state.cachedData?.instanceSettings?.[record.instanceId];
  const box = document.createElement("div");
  box.className = "ov-controls";

  const heading = document.createElement("h3");
  heading.className = "ov-controls-title";
  heading.textContent = "Controls";
  box.appendChild(heading);

  // ── Fail-all switch ──
  const failRow = document.createElement("label");
  failRow.className = "ov-control";

  const failText = document.createElement("span");
  failText.className = "ov-control-label";
  failText.textContent = "Fail all requests (503)";
  const failHint = document.createElement("span");
  failHint.className = "ov-control-hint";
  failHint.textContent =
    "Traffic is still decrypted; every request is answered with 503 instead of reaching the upstream or a mock.";

  const failLabel = document.createElement("span");
  failLabel.className = "ov-control-text";
  failLabel.append(failText, failHint);

  const failSwitch = document.createElement("span");
  failSwitch.className = "switch";
  const failInput = document.createElement("input");
  failInput.type = "checkbox";
  // Inverted on purpose: the switch is ON when requests are being failed.
  failInput.checked = settings ? settings.isActive === false : false;
  failInput.addEventListener("change", () => {
    window.updateSettings?.(record.instanceId, { isActive: !failInput.checked });
  });
  const failSlider = document.createElement("span");
  failSlider.className = "slider";
  failSwitch.append(failInput, failSlider);

  failRow.append(failLabel, failSwitch);
  box.appendChild(failRow);

  // ── Simulated latency ──
  const latencyRow = document.createElement("label");
  latencyRow.className = "ov-control";

  const latencyText = document.createElement("span");
  latencyText.className = "ov-control-label";
  latencyText.textContent = "Simulated latency";
  const latencyHint = document.createElement("span");
  latencyHint.className = "ov-control-hint";
  latencyHint.textContent = "Added to every response from this host, mock or proxied.";
  const latencyLabel = document.createElement("span");
  latencyLabel.className = "ov-control-text";
  latencyLabel.append(latencyText, latencyHint);

  const select = document.createElement("select");
  select.className = "ov-control-select";
  const current = settings?.latency || 0;
  const presets = [0, 250, 500, 1000, 2000, 5000, 10000];
  presets.forEach((ms) => {
    const option = document.createElement("option");
    option.value = String(ms);
    option.textContent = ms === 0 ? "Off" : `${ms} ms`;
    option.selected = ms === current;
    select.appendChild(option);
  });
  // A latency set from the CLI won't match a preset — show it rather than
  // silently snapping the control to a value that isn't in effect.
  //
  // Asked in plain JS, not of the DOM. `option.selected` above sets the
  // *property*; `querySelector("option[selected]")` matches the *attribute*,
  // which nothing here writes — so that test was always true and every host got
  // a duplicate last option. With latency 0 it meant the control read "0 ms"
  // and the "Off" label was never the one on screen.
  if (!presets.includes(current)) {
    const option = document.createElement("option");
    option.value = String(current);
    option.textContent = `${current} ms`;
    option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    window.updateSettings?.(record.instanceId, { latency: Number(select.value) });
  });

  latencyRow.append(latencyLabel, select);
  box.appendChild(latencyRow);

  // ── Upstream ──
  // Editable, and deliberately *not* the same thing as the host above. The host
  // is what gets intercepted; this is where anything unmocked gets forwarded.
  // Pointing them at different places is how you intercept prod and answer from
  // QA — the reason the two are separate fields at all.
  if (instance) {
    box.appendChild(
      editableRow({
        label: "Forward unmocked requests to",
        hint: `Intercepting ${instance.target}. Leave this alone to forward there too.`,
        value: settings?.targetUrl || instance.target,
        placeholder: "https://api.example.com",
        commit: async (value) =>
          (await window.updateSettings?.(record.instanceId, { targetUrl: value }))
            ?.settings?.targetUrl,
      })
    );
  }

  // ── Display name ──
  // Above the id on purpose: this is the one people actually read, and the two
  // being adjacent is what makes it obvious they aren't the same thing.
  if (instance) {
    box.appendChild(
      editableRow({
        label: "Display name",
        hint: "What this host is called in the dashboard and the CLI. A label only.",
        value: instance.name || record.host,
        placeholder: "My API",
        commit: async (value) =>
          (await window.updateSettings?.(record.instanceId, { name: value }))?.name,
      })
    );
  }

  // ── Instance id ──
  box.appendChild(
    editableRow({
      label: "Instance id",
      hint: "Used by mock scopes and the CLI. Renaming rewrites the mocks scoped to it.",
      value: record.instanceId,
      placeholder: "my-api",
      commit: (value) => window.renameInstance?.(record.instanceId, value),
    })
  );

  return box;
}

/**
 * A control row whose value is edited in place.
 *
 * Committed on Enter or on blur, reverted on Escape.
 *
 * `commit` resolves to **the string the server stored**, or something falsy if
 * it refused. Both are then shown: a refusal puts the previous value back rather
 * than leaving a string on screen that never took effect, and an acceptance
 * shows what was actually kept — names get trimmed and URLs reduced to their
 * origin, so `https://a.test/v1` comes back as `https://a.test`.
 *
 * Kept local to the inspector rather than promoted to util.js — the moment a
 * second panel needs it, that is the time to move it, not before.
 */
function editableRow({ label, hint, value, placeholder, commit }) {
  const row = document.createElement("label");
  row.className = "ov-control";

  const text = document.createElement("span");
  text.className = "ov-control-label";
  text.textContent = label;
  const hintEl = document.createElement("span");
  hintEl.className = "ov-control-hint";
  hintEl.textContent = hint;
  const labelWrap = document.createElement("span");
  labelWrap.className = "ov-control-text";
  labelWrap.append(text, hintEl);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ov-control-input";
  input.value = value || "";
  input.placeholder = placeholder;
  input.spellcheck = false;

  let committed = input.value;
  let saving = false;

  const send = async () => {
    const next = input.value.trim();
    // Guarded because Enter blurs the field, which would otherwise fire the
    // same commit a second time.
    if (saving || next === committed) return;
    if (!next) {
      input.value = committed;
      return;
    }
    saving = true;
    const stored = await commit(next);
    saving = false;
    if (stored) committed = stored;
    input.value = committed;
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.value = committed;
      input.blur();
    }
    // The tree and the modals both listen for keys on document; a rename
    // containing an "n" shouldn't also trigger a shortcut.
    event.stopPropagation();
  });
  input.addEventListener("blur", send);

  row.append(labelWrap, input);
  return row;
}

// ── Hits table ───────────────────────────────────────────────────

function renderHits(node) {
  const container = el("insp-hits");
  if (!container) return [];

  const entries = collectEntries(node);
  // Rebuilding the table drops its scroll position; with live traffic that
  // means the list jumps back to the top under the pointer every few hundred
  // milliseconds. Restore it after the swap, as the host tree does.
  const scrollTop = container.scrollTop;
  container.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hits-empty";
    empty.textContent = node
      ? "No requests captured for this selection yet."
      : "Select a host or endpoint on the left.";
    container.appendChild(empty);
    return entries;
  }

  const table = document.createElement("table");
  table.className = "hits-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Time", "Method", "Path", "Status", "Duration", "Source"].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  entries.forEach((entry) => {
    const tr = document.createElement("tr");
    tr.dataset.entryId = entry.id;
    tr.tabIndex = 0;
    if (entry.id === state.selectedEntryId) tr.classList.add("selected");
    if (entry.status >= 400 || entry.status === 0) tr.classList.add("is-error");

    const cells = [
      fmtTime(entry.timestamp),
      entry.method,
      entry.path,
      String(entry.status ?? "—"),
      formatDuration(entry.durationMs),
      srcLabelFor(entry.source),
    ];

    cells.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (index === 1) td.className = `hits-method ${entry.method}`;
      if (index === 2) td.title = entry.path;
      if (index === 5) td.className = `hits-source ${entry.source || "proxy"}`;
      tr.appendChild(td);
    });

    if (entry.replayed) tr.classList.add("is-replayed");
    if (entry.composed) tr.classList.add("is-composed");
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  container.scrollTop = scrollTop;
  return entries;
}

// ── Detail ───────────────────────────────────────────────────────

function renderDetailSection(kind, value, emptyLabel) {
  const { el: node, raw } = renderValue(value, { emptyLabel });
  el(`insp-${kind}`)?.replaceChildren(node);
  state.logDetailRaw[kind] = raw;
}

/** Parse the query string embedded in `path` (the raw originalUrl). */
function parseQueryParams(path) {
  const at = (path || "").indexOf("?");
  if (at === -1) return null;
  const params = new URLSearchParams(path.slice(at + 1));
  const out = {};
  for (const [key, value] of params) {
    if (key in out)
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    else out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function renderDetail(entry) {
  const panel = el("insp-detail");
  const empty = el("insp-detail-empty");
  if (!panel) return;

  if (!entry) {
    panel.hidden = true;
    if (empty) empty.hidden = false;
    _renderedEntryId = null;
    return;
  }

  panel.hidden = false;
  if (empty) empty.hidden = true;
  state.selectedLogEntry = entry;

  // Live traffic re-renders the whole workspace on every batch, but a log
  // record never changes after it's created (see utils/request-log.js) — so if
  // this is the same request we already drew, there is nothing to redraw.
  // Without this, every unrelated request arriving anywhere on the proxy threw
  // you back to Request/Body and wiped your search while you were reading a
  // response.
  if (entry.id === _renderedEntryId) return;
  _renderedEntryId = entry.id;

  const method = el("insp-method");
  if (method) {
    method.textContent = entry.method;
    method.className = `log-method ${entry.method}`;
  }

  const status = el("insp-status");
  if (status) {
    const isErr = entry.status >= 400 || entry.status === 0;
    status.textContent = String(entry.status ?? "—");
    status.className = `log-source ${isErr ? "server-off" : "mock"}`;
  }

  setText("insp-time", new Date(entry.timestamp).toLocaleString());
  setText("insp-duration", formatDuration(entry.durationMs));

  const source = el("insp-source");
  if (source) {
    const cls = entry.source || "proxy";
    source.textContent = srcLabelFor(cls);
    source.className = `log-source ${cls}`;
  }

  setText("insp-path", entry.path);

  const transformError = el("insp-transform-error");
  if (transformError) {
    transformError.hidden = !entry.transformError;
    setText("insp-transform-error-msg", entry.transformError || "");
  }

  // Replaying a body that was cut at the storage cap would send something the
  // client never sent, so the button says why it's unavailable.
  const replayBtn = el("btn-insp-replay");
  if (replayBtn) {
    replayBtn.disabled = Boolean(entry.requestTruncated);
    replayBtn.title = entry.requestTruncated
      ? "Request body was truncated in the log — replay disabled"
      : "Send this request again through the proxy";
  }

  resetSearch();
  // Keep whichever tab the reader was on. The search is per-entry, so it still
  // resets; the viewpoint doesn't.
  switchInspectorTab(_activeTab);

  state.logDetailRaw = {};
  // Shown — and copied — with the names the client actually sent. The log's map
  // is lowercase because that is Node's parse of the request; `requestHeaderCase`
  // carries the spellings back. See utils/header-case.js.
  const reqHeaders = withHeaderCase(entry.requestHeaders, entry.requestHeaderCase);
  renderDetailSection("req-headers", reqHeaders, "No request headers");
  renderDetailSection("req-body", entry.requestBody, "No request body");
  renderDetailSection("res-headers", entry.responseHeaders, "No response headers");
  renderDetailSection("res-body", entry.responseBody, "No response body");

  setText("insp-req-headers-count", String(Object.keys(reqHeaders).length));
  setText(
    "insp-res-headers-count",
    String(Object.keys(entry.responseHeaders || {}).length)
  );

  const query = parseQueryParams(entry.path);
  // No query string means no sub-tab: an empty "Query params (0)" is a tab you
  // click once, learn nothing from, and resent.
  const queryTab = el("insp-sub-req-query");
  if (queryTab) queryTab.hidden = !query;
  if (query) {
    const { el: node, raw } = renderValue(query);
    el("insp-req-query")?.replaceChildren(node);
    setText("insp-req-query-count", String(Object.keys(query).length));
    state.logDetailRaw["req-query"] = raw;
  }

  // Stay on the sub-tab the reader chose. Query is the only one that can be
  // absent, so it's the only one that needs a fallback — Headers, since that's
  // the neighbouring half of "what was sent".
  const wantedReq =
    _activeSubTab.request === "req-query" && !query
      ? "req-headers"
      : _activeSubTab.request;
  switchInspectorSubTab("request", wantedReq);
  switchInspectorSubTab("response", _activeSubTab.response);
}

// ── Public render ────────────────────────────────────────────────

/** Re-render the whole right panel from the current selection. */
export function renderInspector() {
  const node = selectedNode();
  const overview = el("insp-overview");
  const traffic = el("insp-traffic");
  const mocks = el("insp-mocks");
  const requests = el("insp-requests");

  // The two full-pane views replace the traffic panel rather than sitting
  // beside it; each owns its own module and only the mode switch lives here.
  if (state.inspectorMode === "mocks" || state.inspectorMode === "requests") {
    const showingMocks = state.inspectorMode === "mocks";
    if (overview) overview.hidden = true;
    if (traffic) traffic.hidden = true;
    if (mocks) mocks.hidden = !showingMocks;
    if (requests) requests.hidden = showingMocks;
    if (showingMocks) window.renderHostMocks?.();
    else window.renderCollections?.();
    return;
  }
  if (mocks) mocks.hidden = true;
  if (requests) requests.hidden = true;

  if (!node) {
    if (overview) {
      overview.hidden = false;
      const hint = document.createElement("div");
      hint.className = "ov-placeholder";
      hint.textContent = "Select a host or an endpoint on the left to inspect it.";
      overview.replaceChildren(hint);
    }
    if (traffic) traffic.hidden = true;
    return;
  }

  // Host and folder selections lead with the overview; a leaf goes straight to
  // its calls, because that's what you clicked it for.
  const showOverview = node.kind !== "leaf";
  if (overview) {
    overview.hidden = !showOverview;
    // Don't rebuild the panel out from under someone using it — swapping the
    // DOM while the latency dropdown is open closes it mid-choice. The
    // counters it shows are a beat stale until focus leaves, which is a fair
    // trade for controls that stay usable under live traffic.
    const busy = overview.contains(document.activeElement);
    if (showOverview && !busy) overview.replaceChildren(renderOverview(node));
  }
  if (traffic) traffic.hidden = false;

  const entries = renderHits(node);

  // Keep the open call if it's still in range, otherwise fall to the newest.
  let entry = entries.find((e) => e.id === state.selectedEntryId);
  if (!entry && entries.length) {
    entry = entries[0];
    state.selectedEntryId = entry.id;
    el("insp-hits")
      ?.querySelector(`tr[data-entry-id="${CSS.escape(entry.id)}"]`)
      ?.classList.add("selected");
  }
  renderDetail(entry || null);
}

// ── Interaction ──────────────────────────────────────────────────

/**
 * The one sub-tab on screen — Response/Body, say. Handed to the search as its
 * scope: a hit count spanning four sections you can't see is a count of nothing
 * you asked about, and stepping through it drags you between tabs.
 *
 * This stays here, and only this: which tab is showing is the inspector's own
 * business, and it is the single thing panel-search.js can't work out alone.
 */
function activeSection() {
  return (
    el(`insp-panel-${_activeTab}`)?.querySelector(
      `.jt-container[data-sub="${_activeSubTab[_activeTab]}"]`
    ) || null
  );
}

export function initInspector() {
  // `container` is deliberately wider than `section`: switching tabs leaves
  // stale <mark>s behind in the one you left.
  configureSearch({ section: activeSection, container: () => el("insp-detail") });
  loadSearchPrefs();

  const hits = el("insp-hits");
  if (!hits) return;

  hits.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-entry-id]");
    if (!row) return;
    state.selectedEntryId = row.dataset.entryId;
    renderInspector();
  });

  hits.addEventListener("keydown", (event) => {
    const row = event.target.closest("tr[data-entry-id]");
    if (!row || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    state.selectedEntryId = row.dataset.entryId;
    renderInspector();
  });

  hits.addEventListener("contextmenu", (event) => {
    const row = event.target.closest("tr[data-entry-id]");
    if (!row) return;
    // Select on right-click too, as the tree does, so the menu and the detail
    // below it always describe the same request.
    state.selectedEntryId = row.dataset.entryId;
    renderInspector();

    const entry = state.allLogs.find((e) => e.id === row.dataset.entryId);
    if (entry) openContextMenu(event, hitMenuItems(entry));
  });
}

function hitMenuItems(entry) {
  // Shared with the tree's leaf menu — see replayability() for why a request
  // can be un-replayable.
  const { retry, edit, reason } = replayability(entry);

  return [
    { heading: `${entry.method} ${entry.path.split("?")[0]}` },
    {
      label: "Retry",
      hint: reason,
      disabled: !retry,
      onSelect: () => replayEntry(entry.id),
    },
    {
      label: "Retry with modifications…",
      hint: edit ? "" : reason,
      disabled: !edit,
      onSelect: () => window.openReplayEditor?.(entry.id),
    },
    { separator: true },
    {
      label: "Create mock from this call",
      onSelect: () => createMockFromEntry(entry.id),
    },
    { separator: true },
    { label: "Copy as cURL", onSelect: () => copyAsCurl(entry) },
    { label: "Copy path", onSelect: () => copyText(entry.path, "Path copied!") },
    { separator: true },
    {
      label: "Clear this host's log",
      disabled: !entry.host,
      onSelect: () => clearEntries(entry.host),
    },
  ];
}

export function switchInspectorTab(tab) {
  _activeTab = tab;
  ["request", "response"].forEach((name) => {
    const isActive = name === tab;
    const panel = el(`insp-panel-${name}`);
    if (panel) {
      panel.hidden = !isActive;
      panel.classList.toggle("active", isActive);
    }
    const btn = el(`insp-tab-${name}`);
    if (btn) {
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
    }
  });
  rescopeSearch();
}

/**
 * Show one of a panel's Query / Headers / Body sub-tabs.
 *
 * Each gets the panel's full height instead of the three sharing one scroll
 * container, where a long headers list pushed the body out of sight.
 *
 * @param {"request"|"response"} panel
 * @param {string} sub the section key, e.g. "req-body"
 */
export function switchInspectorSubTab(panel, sub) {
  const root = el(`insp-panel-${panel}`);
  if (!root) return;
  _activeSubTab[panel] = sub;

  root.querySelectorAll(".jt-container[data-sub]").forEach((container) => {
    container.hidden = container.dataset.sub !== sub;
  });
  root.querySelectorAll(".insp-subtab").forEach((btn) => {
    const isActive = btn.id === `insp-sub-${sub}`;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
  if (panel === _activeTab) rescopeSearch();
}

/** Copy whichever sub-tab is currently showing in this panel. */
export function copyVisibleSection(panel) {
  copyInspectorSection(_activeSubTab[panel]);
}

// ── Actions ──────────────────────────────────────────────────────

export async function replayCurrent() {
  if (state.selectedLogEntry) await replayEntry(state.selectedLogEntry.id);
}

export function copyInspectorSection(kind) {
  const raw = state.logDetailRaw?.[kind];
  if (!raw) return toast("Nothing to copy", "warning");
  copyText(raw);
}

export function copyAsCurl(entryOrEvent) {
  // Called both from the footer button (no argument) and from the hits
  // context menu (an explicit entry).
  const entry = entryOrEvent && entryOrEvent.id ? entryOrEvent : state.selectedLogEntry;
  if (!entry) return;

  // Prefer the real origin now that entries carry it; fall back to the
  // instance target, then to the dashboard's own origin.
  let url = entry.path;
  if (!/^https?:\/\//.test(url)) {
    if (entry.host) {
      const scheme = entry.protocol || "https";
      const port =
        entry.port && entry.port !== (scheme === "https" ? 443 : 80)
          ? `:${entry.port}`
          : "";
      url = `${scheme}://${entry.host}${port}${entry.path}`;
    } else {
      const instance = state.cachedData?.instances?.find(
        (i) => i.id === entry.instanceId
      );
      const origin = window.location.origin === "null" ? "" : window.location.origin;
      url = (instance?.target || origin) + entry.path;
    }
  }

  let curl = `curl -X ${entry.method} "${url}"`;
  // A cURL that spells the headers differently from the request it claims to
  // reproduce is the same lie the proxy stopped telling upstream.
  const curlHeaders = withHeaderCase(entry.requestHeaders, entry.requestHeaderCase);
  Object.entries(curlHeaders).forEach(([key, value]) => {
    if (key.startsWith(":")) return;
    curl += ` \\\n  -H "${key}: ${value}"`;
  });

  if (entry.requestBody) {
    const body =
      typeof entry.requestBody === "object"
        ? JSON.stringify(entry.requestBody)
        : String(entry.requestBody);
    curl += ` \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
  }

  copyText(curl, "cURL command copied!");
}

/**
 * Turn a captured call into a `.mock.js` and open it in the editor.
 * Reachable from the detail footer and from a leaf's right-click menu.
 */
export async function createMockFromEntry(id) {
  const entry = id ? state.allLogs.find((e) => e.id === id) : state.selectedLogEntry;
  if (!entry) return;

  const cleanPath = entry.path.split("?")[0].replace(/^\/|\/$/g, "");
  const mockPath = await showPrompt({
    title: "✨ Create mock from this call",
    label: `${entry.method} ${entry.path.split("?")[0]} — where should it live?`,
    value: cleanPath,
    placeholder: "auth/login",
    confirmLabel: "Create",
    validate: (value) => validateMockPath(value),
  });
  if (!mockPath) return;

  const fileName = mockPath.endsWith(".mock.js") ? mockPath : `${mockPath}.mock.js`;

  const res = await api("/__admin/create-mock", {
    method: "POST",
    body: { name: mockPath },
  });
  if (!res.ok) {
    toast("Failed to initialize mock: " + (await res.text()), "error");
    return;
  }

  const body = entry.responseBody
    ? typeof entry.responseBody === "object"
      ? JSON.stringify(entry.responseBody, null, 4)
      : String(entry.responseBody)
    : "{}";

  const matchPath = "/" + cleanPath;
  const template = `module.exports = {
  name: "Mock: ${entry.method} ${matchPath}",
  delay: 0,
  match: (req) => req.path === '${matchPath}' && req.method === '${entry.method}',
  respond: (req, res) => {
    res.status(${entry.status || 200}).json(${body});
  }
};
`;

  let editor;
  try {
    editor = await ensureEditor();
  } catch (err) {
    toast(err.message || "Failed to load the code editor", "error");
    return;
  }

  state.currentFile = fileName;
  el("editing-filename").innerText = `New Mock: ${fileName}`;
  editor.setValue(template, -1);
  state.editorBaseline = editor.getValue();
  el("editor-modal").style.display = "flex";
}
