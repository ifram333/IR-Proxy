/**
 * hosts.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The left panel: the host tree, its selection, and its right-click menus.
 *
 * Two conventions differ from the older dashboard modules on purpose:
 *
 *  1. **Real DOM, never `innerHTML`.** Every string here — hostnames, path
 *     segments — arrives from the network. The old code could interpolate
 *     freely because those values came from config.js; now a host is whatever a
 *     device asked for, so it goes through `textContent` and `dataset` only.
 *  2. **Delegated events, not inline `onclick`.** A `contextmenu` handler can't
 *     be expressed as an inline attribute that carries node identity, and paths
 *     contain quotes that `escapeHtml` doesn't protect in a JS-string context.
 *     One listener per panel root reads `data-*` instead.
 */
import { state, srcLabelFor } from "./state.js";
import { showConfirm } from "./util.js";
import { buildTree, findNode } from "./tree-model.js";
import { openContextMenu } from "./contextmenu.js";
import {
  setHostSsl,
  setHostFocus,
  setPathBlocked,
  forgetHost,
  clearEntries,
  replayEntry,
  replayability,
  refresh,
} from "./entries.js";

let _model = { sections: [], total: 0, matched: 0 };

const SECTIONS_KEY = "ir-proxy.sections";

/** Restore which tree sections were collapsed. Never throws — a corrupt value
 *  just means everything starts expanded. */
export function loadCollapsedSections() {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) state.collapsedSections = new Set(list);
  } catch {
    /* start expanded */
  }
}

function saveCollapsedSections() {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify([...state.collapsedSections]));
  } catch {
    // Private mode or full storage: the toggle worked, it just won't stick.
  }
}

/** The currently selected node, re-resolved against the latest model. */
export function selectedNode() {
  return findNode(_model, state.selectedNodeId);
}

export function currentModel() {
  return _model;
}

// ── Rendering ────────────────────────────────────────────────────

function badge(className, text, title) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

function renderHostRow(host) {
  const row = document.createElement("div");
  row.className = "tree-row tree-host";
  row.dataset.kind = "host";
  row.dataset.id = host.id;
  row.dataset.host = host.host;
  row.tabIndex = 0;
  if (state.selectedNodeId === host.id) row.classList.add("selected");

  const collapsed = state.collapsedNodes.has(host.id);
  const twisty = document.createElement("span");
  twisty.className = "tree-twisty";
  twisty.textContent = host.children.length ? (collapsed ? "▸" : "▾") : "";
  row.appendChild(twisty);

  // The padlock is the primary signal in this whole UI: is this host being
  // decrypted, or are we only watching connections go past?
  row.appendChild(
    badge(
      host.ssl ? "tree-lock on" : "tree-lock off",
      host.ssl ? "🔒" : "🔓",
      host.ssl ? "SSL proxying is on — traffic is decrypted" : "SSL proxying is off"
    )
  );

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = host.host;
  name.title = host.host;
  row.appendChild(name);

  if (host.errors > 0) {
    row.appendChild(badge("tree-errors", String(host.errors), `${host.errors} failed`));
  }

  // Be honest about what the number means: with SSL off all we can count is
  // CONNECT tunnels, and one tunnel carries many requests.
  const count = host.ssl ? host.hits : host.connections || 0;
  const label = host.ssl ? "requests" : "connections";
  if (count) {
    row.appendChild(badge("tree-count", String(count), `${count} ${label}`));
  }

  return row;
}

/**
 * One row builder for both path kinds, because a path can be both.
 *
 * `/service-status` with `/service-status/123` under it is an endpoint *and* a
 * folder: it gets the twisty of a folder and the method/status badges of a leaf,
 * so you can see at a glance that the row is worth clicking and not just worth
 * expanding. A folder nobody called directly keeps the 📁 and shows only what it
 * aggregates.
 */
function renderPathRow(node, depth) {
  const isFolder = node.kind === "folder";
  const ownCalls = node.entries?.length || 0;

  const row = document.createElement("div");
  row.className = `tree-row ${isFolder ? "tree-folder" : "tree-leaf"}`;
  if (isFolder && ownCalls) row.classList.add("tree-endpoint-folder");
  row.dataset.kind = node.kind;
  row.dataset.id = node.id;
  row.dataset.host = node.host;
  row.style.setProperty("--depth", String(depth));
  row.tabIndex = 0;
  if (state.selectedNodeId === node.id) row.classList.add("selected");

  // Leaves keep the same element as a spacer, so every row's name starts at the
  // same x whatever its depth.
  const twisty = document.createElement("span");
  twisty.className = "tree-twisty";
  if (isFolder) twisty.textContent = state.collapsedNodes.has(node.id) ? "▸" : "▾";
  row.appendChild(twisty);

  if (isFolder && !ownCalls) {
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = "📁";
    row.appendChild(icon);
  } else {
    const method = document.createElement("span");
    method.className = `tree-method ${node.method || ""}`;
    method.textContent = node.method || "—";
    if (node.methods.length > 1) method.title = node.methods.join(", ");
    row.appendChild(method);
  }

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = node.name;
  name.title = node.path;
  row.appendChild(name);

  // State, not history: the tag says this path is blocked right now, whether or
  // not anything has hit it since. It takes the source badge's place rather than
  // sitting next to it — that badge answers "what happens when this is called",
  // and the answer is now "nothing". Leaving the old MOCK/PROXY there would
  // describe a call that can no longer happen, and once a blocked call is
  // logged its own source is `blocked`, so the row would read BLOCK twice.
  const blocked = Boolean(node.blockedBy);
  if (blocked) {
    row.appendChild(
      badge(
        "tree-source blocked",
        "BLOCK",
        node.blockOwner
          ? "Blocked — calls to this path are killed"
          : `Blocked by ${node.blockedBy}`
      )
    );
  }

  if (isFolder && node.errors > 0) {
    row.appendChild(badge("tree-errors", String(node.errors)));
  }

  if (ownCalls) {
    if (node.source && !blocked) {
      // Through the label map, like the hits table — uppercasing the raw source
      // spelled the same states two ways across the two panels, `SERVER-OFF`
      // here against `OFF` there, and now `BLOCKED` against `BLOCK`.
      row.appendChild(badge(`tree-source ${node.source}`, srcLabelFor(node.source)));
    }
    if (node.status != null && !blocked) {
      const isErr = node.status >= 400 || node.status === 0;
      row.appendChild(
        badge(`tree-status ${isErr ? "err" : "ok"}`, String(node.status || "—"))
      );
    }
    // A path hit many times stays one row; the count is how you notice polling.
    // On a folder it counts the calls to the path *itself* — the aggregate is
    // one expand away, and the number you want here is "was this endpoint hit".
    if (ownCalls > 1 || (isFolder && ownCalls)) {
      row.appendChild(
        badge(
          "tree-count",
          `×${ownCalls}`,
          isFolder
            ? `${ownCalls} calls to this path, ${node.hits} including everything under it`
            : `${ownCalls} calls`
        )
      );
    }
  }

  return row;
}

function renderChildren(container, node, depth) {
  if (state.collapsedNodes.has(node.id)) return;
  node.children.forEach((child) => {
    container.appendChild(renderPathRow(child, depth));
    if (child.kind === "folder") renderChildren(container, child, depth + 1);
  });
}

function renderSection(section) {
  const collapsed = state.collapsedSections.has(section.key);

  const wrapper = document.createElement("div");
  wrapper.className = `tree-section tree-section-${section.key}`;

  const heading = document.createElement("button");
  heading.type = "button";
  heading.className = "tree-section-heading";
  heading.dataset.section = section.key;
  heading.setAttribute("aria-expanded", String(!collapsed));

  const twisty = document.createElement("span");
  twisty.className = "tree-twisty";
  twisty.textContent = collapsed ? "▸" : "▾";
  heading.appendChild(twisty);

  const label = document.createElement("span");
  label.className = "tree-section-label";
  label.textContent = section.label;
  heading.appendChild(label);

  // The count stays visible while collapsed — it's the only signal that
  // something is hidden in there.
  const count = document.createElement("span");
  count.className = "tree-section-count";
  count.textContent = String(section.hosts.length);
  heading.appendChild(count);

  wrapper.appendChild(heading);

  // Skip the rows entirely rather than hiding them with CSS: this tree
  // re-renders on every batch of live traffic, so not building them is the
  // cheap path.
  if (collapsed) return wrapper;

  if (section.hosts.length === 0) {
    // The default section is the one that explains itself when empty; the
    // other two are self-evidently empty until you put something in them.
    if (section.key === "none") {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = state.treeQuery
        ? "No hosts match this filter."
        : "No traffic yet. Point a device at this proxy and hosts will appear here.";
      wrapper.appendChild(empty);
    }
    return wrapper;
  }

  section.hosts.forEach((host) => {
    wrapper.appendChild(renderHostRow(host));
    renderChildren(wrapper, host, 1);
  });

  return wrapper;
}

/** Rebuild the tree from the current entries + hosts. */
export function renderTree() {
  const container = document.getElementById("host-tree");
  if (!container) return;

  _model = buildTree({
    hosts: state.hosts,
    entries: state.allLogs,
    query: state.treeQuery,
  });

  // Preserve scroll across the rebuild — a live stream re-renders constantly
  // and yanking the viewport back to the top would make the tree unusable.
  const scrollTop = container.scrollTop;
  const fragment = document.createDocumentFragment();
  _model.sections.forEach((section) => {
    // Ignored hosts are collapsed away unless there's something in there.
    if (section.key === "ignore" && section.hosts.length === 0) return;
    if (section.key === "focus" && section.hosts.length === 0) return;
    fragment.appendChild(renderSection(section));
  });

  container.replaceChildren(fragment);
  container.scrollTop = scrollTop;

  const counter = document.getElementById("tree-count");
  if (counter) {
    counter.textContent = state.treeQuery
      ? `${_model.matched} of ${_model.total}`
      : `${_model.total} requests`;
  }
}

// ── Interaction ──────────────────────────────────────────────────

function nodeFromEvent(event) {
  const row = event.target.closest(".tree-row");
  if (!row) return null;
  return findNode(_model, row.dataset.id);
}

function toggleSection(key) {
  if (!key) return;
  if (state.collapsedSections.has(key)) state.collapsedSections.delete(key);
  else state.collapsedSections.add(key);
  saveCollapsedSections();
  renderTree();
}

function toggleCollapse(node) {
  if (state.collapsedNodes.has(node.id)) state.collapsedNodes.delete(node.id);
  else state.collapsedNodes.add(node.id);
  renderTree();
}

function select(node) {
  state.selectedNodeId = node.id;
  // Picking a different node invalidates whichever hit was open.
  state.selectedEntryId = null;
  state.inspectorMode = "traffic";
  refresh();
}

// ── Context menus ────────────────────────────────────────────────

function hostMenuItems(node) {
  const host = state.hosts.find((h) => h.host === node.host) || {
    host: node.host,
    ssl: false,
    focus: "none",
  };

  return [
    { heading: node.host },
    {
      label: host.ssl ? "Disable SSL Proxying" : "Enable SSL Proxying",
      checked: host.ssl,
      onSelect: () => onToggleSsl(host),
    },
    { separator: true },
    {
      label: "Focus",
      checked: host.focus === "focus",
      disabled: host.focus === "focus",
      onSelect: () => setHostFocus(node.host, "focus"),
    },
    {
      label: "Unfocus",
      disabled: host.focus === "none",
      onSelect: () => setHostFocus(node.host, "none"),
    },
    {
      label: "Ignore",
      checked: host.focus === "ignore",
      disabled: host.focus === "ignore",
      onSelect: () => setHostFocus(node.host, "ignore"),
    },
    { separator: true },
    {
      label: "Open mocks",
      hint: host.ssl ? "" : "SSL off",
      onSelect: () => openMocksFor(node.host),
    },
    { separator: true },
    { label: "Clear this host's log", onSelect: () => clearEntries(node.host) },
    { label: "Remove host from list", danger: true, onSelect: () => onForget(node.host) },
  ];
}

async function onToggleSsl(host) {
  if (!host.ssl) {
    // Turning this on is the one action here that can break the device being
    // debugged: an app that pins its certificate will simply stop talking to
    // the network, with no error a user could interpret.
    const ok = await showConfirm(
      `Decrypt traffic for “${host.host}”?\n\n` +
        `The device must trust this proxy's CA. Apps that pin their certificate ` +
        `will fail to connect until you turn this back off.`
    );
    if (!ok) return;
  }
  await setHostSsl(host.host, !host.ssl);
  // Enabling promotes the host to an instance, so the mock/instance data the
  // rest of the dashboard reads is now stale.
  await window.load?.();
  refresh();
}

/**
 * Removing a host now removes the instance behind it too, and that instance is
 * where the mock toggles live. Say how many are about to go: it is the
 * destructive part of the action and nothing on the row hints at it.
 */
async function onForget(host) {
  const record = state.hosts.find((h) => h.host === host);
  const toggles = Object.values(
    state.cachedData?.states?.[record?.instanceId] || {}
  ).length;

  const ok = await showConfirm(
    `Remove “${host}” from the list?\n\n` +
      `Its log entries are discarded` +
      (toggles
        ? `, and the instance behind it is deleted along with its ` +
          `${toggles} mock toggle${toggles === 1 ? "" : "s"}.`
        : ` and the instance behind it is deleted.`) +
      `\n\nThe mock files themselves are not touched.`
  );
  if (ok) {
    await forgetHost(host);
    // The instance is gone, so everything keyed by it downstream is stale.
    await window.load?.();
  }
}

function openMocksFor(host) {
  const record = state.hosts.find((h) => h.host === host);
  state.selectedNodeId = `host:${host}`;
  state.inspectorMode = "mocks";
  state.mocksHost = host;
  state.mocksInstanceId = record?.instanceId || null;
  // Fetch the hit counts before the first paint, or the column shows every mock
  // as never-fired for a beat.
  window.refreshMockStats?.(true);
  refresh();
}

/**
 * The block toggle, shared by both path menus — it applies to a folder and a
 * leaf identically, which is the point of a rule being a prefix.
 *
 * A path blocked by an **ancestor** offers to lift that ancestor, named in the
 * label, rather than a no-op "unblock" on itself: unblocking exactly this path
 * would remove a rule that was never there and leave the row just as dead.
 */
function blockMenuItem(node) {
  if (!node.blockedBy) {
    return {
      label: "Block this path",
      hint: "calls die immediately",
      onSelect: () => setPathBlocked(node.host, node.path, true),
    };
  }
  return {
    label: node.blockOwner ? "Unblock this path" : `Unblock ${node.blockedBy}`,
    hint: node.blockOwner ? "" : "blocked by a parent",
    onSelect: () => setPathBlocked(node.host, node.blockedBy, false),
  };
}

function leafMenuItems(node) {
  const newest = node.entries[0];
  const { retry, edit, reason } = replayability(newest);

  return [
    { heading: node.path },
    {
      label: "Retry",
      hint: reason,
      disabled: !newest || !retry,
      onSelect: () => replayEntry(newest.id),
    },
    {
      label: "Retry with modifications…",
      hint: edit ? "" : reason,
      disabled: !newest || !edit,
      onSelect: () => window.openReplayEditor?.(newest.id),
    },
    {
      label: "Create mock from this call",
      disabled: !newest,
      onSelect: () => window.createMockFromEntry?.(newest.id),
    },
    { separator: true },
    blockMenuItem(node),
    { separator: true },
    { label: "Open mocks for this host", onSelect: () => openMocksFor(node.host) },
    { separator: true },
    { label: "Clear this host's log", onSelect: () => clearEntries(node.host) },
  ];
}

function folderMenuItems(node) {
  return [
    { heading: node.path },
    blockMenuItem(node),
    { separator: true },
    { label: "Open mocks for this host", onSelect: () => openMocksFor(node.host) },
    { separator: true },
    { label: "Clear this host's log", onSelect: () => clearEntries(node.host) },
  ];
}

// ── Wiring ───────────────────────────────────────────────────────

/** Attach the delegated listeners. Called once at boot. */
export function initTree() {
  const container = document.getElementById("host-tree");
  if (!container) return;

  container.addEventListener("click", (event) => {
    // Section headings are checked first: they sit outside any .tree-row, so
    // the row lookup below would just miss them.
    const heading = event.target.closest(".tree-section-heading");
    if (heading) return toggleSection(heading.dataset.section);

    const node = nodeFromEvent(event);
    if (!node) return;
    // The twisty expands; anywhere else on the row selects.
    if (event.target.classList.contains("tree-twisty") && node.kind !== "leaf") {
      return toggleCollapse(node);
    }
    select(node);
  });

  container.addEventListener("dblclick", (event) => {
    const node = nodeFromEvent(event);
    if (node && node.kind !== "leaf") toggleCollapse(node);
  });

  container.addEventListener("contextmenu", (event) => {
    const node = nodeFromEvent(event);
    if (!node) return;
    // Right-click selects too, so the inspector matches what the menu acts on.
    select(node);
    // Keyed on "does this path have calls of its own", not on folder/leaf: a
    // folder that is also an endpoint has a newest call to retry and to build a
    // mock from, and that menu is a superset of the folder one.
    const items =
      node.kind === "host"
        ? hostMenuItems(node)
        : node.entries?.length
          ? leafMenuItems(node)
          : folderMenuItems(node);
    openContextMenu(event, items);
  });

  container.addEventListener("keydown", (event) => {
    const node = nodeFromEvent(event);
    if (!node) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(node);
    } else if (event.key === "ArrowRight" && node.kind !== "leaf") {
      if (state.collapsedNodes.has(node.id)) toggleCollapse(node);
    } else if (event.key === "ArrowLeft" && node.kind !== "leaf") {
      if (!state.collapsedNodes.has(node.id)) toggleCollapse(node);
    }
  });
}

/** Filter box handler. */
export function handleTreeSearch(value) {
  state.treeQuery = value;
  renderTree();
}
