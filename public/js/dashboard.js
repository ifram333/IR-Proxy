/**
 * dashboard.js — entry point.
 *
 * Boots the workspace (host tree ⇄ inspector), wires the splitters, and owns
 * what belongs to no single panel: config loading, the health badge, profiles,
 * the header popovers and the keyboard shortcuts. Each panel lives in its own
 * module under `modules/` — the tree, the inspector, the mock matrix, the
 * request editor.
 *
 * Two handler conventions coexist across those modules, deliberately:
 *  • The **modals** (editor, confirm, scope, install guide, shortcuts) and the
 *    mock matrix keep the original inline `onclick` → `window` convention. They
 *    work, and rewriting them would be churn.
 *  • The **tree and inspector** use delegated listeners reading `data-*`. They
 *    render hostnames and paths that arrive off the network, which can't be
 *    interpolated into an inline attribute safely.
 * The loop at the bottom keeps the first convention working by binding every
 * exported handler onto `window`. That same `window` is how the panel modules
 * call back up here (`load`, `render`, `closeSettings`) without importing this
 * file and making the graph cyclic.
 */
import { state, HEALTH_INTERVAL_MS } from "./modules/state.js";
import {
  getApiUrl,
  api,
  toast,
  showConfirm,
  resolveConfirm,
  showPrompt,
  resolvePrompt,
  submitPrompt,
  debounce,
  combo,
  KEY_LABEL,
} from "./modules/util.js";
import * as access from "./modules/access.js";
import * as certs from "./modules/certs.js";
import * as collections from "./modules/collections.js";
import * as editor from "./modules/editor.js";
import * as entries from "./modules/entries.js";
import * as hosts from "./modules/hosts.js";
import * as inspector from "./modules/inspector.js";
import * as mocks from "./modules/mocks.js";
import * as panelSearch from "./modules/panel-search.js";
import * as requestEditor from "./modules/request-editor.js";
import { createSplitter, applyStoredPaneSizes } from "./modules/splitter.js";
import {
  openContextMenu,
  closeContextMenu,
  isContextMenuOpen,
} from "./modules/contextmenu.js";

// ── Data ─────────────────────────────────────────────────────────

/** Reload /__admin/config (instances, mocks, toggles) and repaint. */
async function load() {
  try {
    const res = await fetch(getApiUrl("/__admin/config"));
    state.cachedData = await res.json();
    render();
  } catch (err) {
    console.error("Failed to load config", err);
  }
}

/** One render pass for everything the current state drives. */
function render() {
  hosts.renderTree();
  inspector.renderInspector();
  if (state.cachedData) {
    renderProfiles(state.cachedData.profiles || {});
    setStandaloneCheckbox(state.cachedData.standaloneInstances);
  }
}

// ── Profiles ─────────────────────────────────────────────────────

/**
 * Real DOM, and one delegated listener — not `innerHTML` with an interpolated
 * `onclick`.
 *
 * A profile name is whatever `POST /__admin/profiles/save` was handed, so it went
 * straight from the wire into markup and into an attribute, quote-escaped by
 * hand. That made it the one stored-XSS hole in the dashboard, in the page that
 * can read every decrypted request. Escaping the string would have closed this
 * instance; building nodes closes the class, so the next person to add a chip
 * can't reopen it.
 */
function renderProfiles(profiles) {
  const list = document.getElementById("profiles-list");
  if (!list) return;

  const names = Object.keys(profiles);
  list.replaceChildren();

  if (names.length === 0) {
    const empty = document.createElement("span");
    empty.className = "no-profiles";
    empty.textContent = "No profiles saved yet.";
    list.appendChild(empty);
    return;
  }

  names.forEach((name) => {
    const chip = document.createElement("div");
    chip.className = "profile-chip";

    const load = document.createElement("button");
    load.className = "p-load";
    load.dataset.profile = name;
    load.dataset.action = "load";
    load.textContent = `📋 ${name}`;

    const del = document.createElement("button");
    del.className = "p-del";
    del.dataset.profile = name;
    del.dataset.action = "delete";
    del.title = "Delete profile";
    del.textContent = "×";

    chip.append(load, del);
    list.appendChild(chip);
  });
}

/** Bound once at boot; the chips above carry their identity in `dataset`. */
function initProfileList() {
  const list = document.getElementById("profiles-list");
  list?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action][data-profile]");
    if (!button) return;
    const { action, profile } = button.dataset;
    if (action === "load") loadProfile(profile);
    else if (action === "delete") deleteProfile(profile);
  });
}

async function saveProfile() {
  const name = await showPrompt({
    title: "💾 Save scenario profile",
    label: "A snapshot of every mock toggle, by name",
    placeholder: "Checkout — happy path",
    confirmLabel: "Save",
    // The same rules the server enforces, said before the round trip rather
    // than after it. See validateName in utils/instance-manager.js.
    validate: (value) => {
      if (!value) return "";
      if (value.length > 64) return "64 characters or fewer.";
      // eslint-disable-next-line no-control-regex -- control chars are rejected on purpose
      if (/[<>&"'`\x00-\x1f]/.test(value)) return "Avoid < > & \" ' ` in the name.";
      // A warning, not an error: overwriting a profile is a normal thing to
      // want, it just shouldn't happen by surprise.
      if (state.cachedData?.profiles?.[value]) {
        return { warning: `“${value}” already exists and will be overwritten.` };
      }
      return "";
    },
  });
  if (!name) return;
  const res = await api("/__admin/profiles/save", { method: "POST", body: { name } });
  if (res.ok) {
    toast(`Profile "${name}" saved`);
    load();
  } else toast("Failed to save profile: " + (await res.text()), "error");
}
async function loadProfile(name) {
  const ok = await showConfirm(
    `Load profile "${name}"? This will override all current mock toggles.`
  );
  if (!ok) return;
  const res = await api("/__admin/profiles/load", { method: "POST", body: { name } });
  if (res.ok) {
    toast(`Profile "${name}" loaded`);
    load();
  } else toast("Failed to load profile: " + (await res.text()), "error");
}
async function deleteProfile(name) {
  const ok = await showConfirm(`Delete profile "${name}"?`);
  if (!ok) return;
  const res = await api("/__admin/profiles/delete", { method: "POST", body: { name } });
  if (res.ok) {
    toast(`Profile "${name}" deleted`, "info");
    load();
  } else toast("Failed to delete profile: " + (await res.text()), "error");
}

// ── Instances & standalone ───────────────────────────────────────

function setStandaloneCheckbox(enabled) {
  const cb = document.getElementById("standalone-checkbox");
  if (cb) cb.checked = !!enabled;
}

async function toggleStandalone(enabled) {
  const res = await api("/__admin/standalone", { method: "POST", body: { enabled } });
  if (res.ok) {
    toast(`Standalone servers ${enabled ? "started" : "stopped"}`);
    load();
  } else {
    toast("Failed to toggle standalone: " + (await res.text()), "error");
    setStandaloneCheckbox(!enabled);
  }
}

/**
 * Patch one instance's settings.
 *
 * @returns {Promise<object|null>} the saved settings, or null when the server
 * refused. Both halves matter to the editable fields: a rejection has to put the
 * old value back rather than leave a string on screen that never took effect,
 * and an acceptance has to show what was *stored* — the server trims names and
 * reduces a URL to its origin, so what you typed is not always what it kept.
 */
async function updateSettings(id, settings) {
  const res = await api("/__admin/instance-settings", {
    method: "POST",
    body: { instanceId: id, ...settings },
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    toast(error || "Could not save that setting", "error");
    load();
    return null;
  }
  const body = await res.json().catch(() => ({}));
  load();
  return body;
}

/**
 * Rename an instance, rewriting the mock files scoped to it.
 *
 * The count comes from the already-loaded config rather than a preflight call:
 * every mock's `servers` scope is in there, so the warning costs nothing and the
 * user learns their source files are about to be edited *before* agreeing.
 */
async function renameInstance(oldId, requested) {
  const scoped = (state.cachedData?.mocks || []).filter((m) =>
    (m.servers || []).includes(oldId)
  ).length;

  if (scoped) {
    const ok = await showConfirm(
      `Rename "${oldId}"? ${scoped} mock file${scoped === 1 ? "" : "s"} scope ` +
        `themselves to this id and will be rewritten to match.`
    );
    if (!ok) return null;
  }

  const res = await api(`/__admin/instances/${encodeURIComponent(oldId)}/rename`, {
    method: "POST",
    body: { id: requested },
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    toast(error || "Could not rename the instance", "error");
    load();
    return null;
  }

  const { id } = await res.json();
  // Say what it became rather than what was typed — the id is slugified
  // server-side, so "PROD API" silently arrives as "prod-api".
  toast(`Renamed to "${id}"`, "success");
  await Promise.all([load(), entries.fetchHosts()]);
  return id;
}

async function submitAddInstance() {
  const input = document.getElementById("add-instance-target");
  const target = input.value.trim();
  if (!target) return toast("Enter a target URL", "warning");

  const res = await api("/__admin/instances", { method: "POST", body: { target } });
  if (res.ok) {
    input.value = "";
    closeSettings();
    toast("Host added with SSL proxying on");
    await Promise.all([load(), entries.fetchHosts()]);
  } else {
    const { error } = await res.json().catch(() => ({}));
    toast(error || "Could not add the host", "error");
  }
}

// ── Header popovers ──────────────────────────────────────────────

function toggleSettings(event) {
  event.stopPropagation();
  document.getElementById("settings-wrapper").classList.toggle("open");
}
function closeSettings() {
  document.getElementById("settings-wrapper")?.classList.remove("open");
}

// ── Log actions ──────────────────────────────────────────────────

async function clearAllEntries() {
  const ok = await showConfirm("Clear every captured request?");
  if (ok) await entries.clearEntries();
}

// ── Health & proxy status ────────────────────────────────────────

async function updateHealth() {
  try {
    const [healthRes, statusRes] = await Promise.all([
      fetch(getApiUrl("/__admin/health")),
      fetch(getApiUrl("/__admin/proxy/status")),
    ]);

    const health = await healthRes.json();
    state.proxyStatus = await statusRes.json();

    const mins = Math.floor(health.uptime / 60);
    const hrs = Math.floor(mins / 60);
    const uptime = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
    document.getElementById("health-info").textContent =
      `${health.mockCount} mocks · up ${uptime}`;
    document.querySelector(".health-dot").className = "health-dot";
    setStandaloneCheckbox(health.standaloneInstances);
    renderLogStats(health.log);

    if (state.proxyStatus.localIPs?.length > 0) {
      const ip = state.proxyStatus.localIPs[0];
      const port = window.location.port || "8888";
      document.getElementById("proxy-status-text").textContent = `${ip}:${port}`;
      document.getElementById("proxy-status-badge").style.display = "flex";
    }
  } catch {
    document.querySelector(".health-dot").className = "health-dot offline";
    document.getElementById("health-info").textContent = "offline";
  }
}

/**
 * What the activity log is holding, in the header.
 *
 * Deliberately quiet until it matters: a fraction of the cap reads as noise, and
 * the number only becomes interesting when you're deciding whether to clear or
 * pause. It turns amber past 60% of either cap.
 */
function renderLogStats(log) {
  const badge = document.getElementById("log-stats");
  if (!badge || !log) return;

  state.logPaused = log.paused === true;

  const mb = log.bytes / (1024 * 1024);
  const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(log.bytes / 1024)} KB`;
  const fullness = Math.max(log.entries / (log.maxEntries || 1), mb / 256);

  badge.textContent = log.paused ? `⏸ paused · ${size}` : `${log.entries} · ${size}`;
  badge.title = log.paused
    ? "Recording is paused. Traffic still flows and mocks still fire — nothing is being kept."
    : `${log.entries} of ${log.maxEntries} requests kept, about ${size}.\n` +
      `Click to pause recording without stopping the proxy.`;
  badge.classList.toggle("warn", !log.paused && fullness > 0.6);
  badge.classList.toggle("paused", log.paused);
  badge.style.display = "";
}

async function toggleLogPaused() {
  const paused = !state.logPaused;
  const res = await api("/__admin/log-paused", { method: "POST", body: { paused } });
  if (!res.ok) return toast("Could not change the recording state", "error");
  const { stats } = await res.json();
  renderLogStats(stats);
  toast(
    paused ? "Recording paused — traffic and mocks are unaffected" : "Recording resumed",
    paused ? "info" : "success"
  );
}

/**
 * This machine's LAN address changed under us.
 *
 * Worth interrupting for: every device with the old address in its proxy
 * settings is now talking to nothing, and nothing else on screen would say so.
 * The header badge is the durable part — the toast is only there to catch the
 * eye, since the change usually happens while nobody is looking at the tab.
 */
function handleNetworkChange({ localIPs, port, previous }) {
  if (!Array.isArray(localIPs)) return;
  if (state.proxyStatus) state.proxyStatus.localIPs = localIPs;

  const badge = document.getElementById("proxy-status-text");
  if (badge) {
    badge.textContent = localIPs.length
      ? `${localIPs[0]}:${port || window.location.port || "8888"}`
      : "no network";
  }

  const was = (previous || []).join(", ");
  toast(
    localIPs.length
      ? `This machine's address changed to ${localIPs[0]}${was ? ` (was ${was})` : ""} — devices pointed at the old one need updating`
      : "This machine lost its network connection — only reachable locally",
    "warning"
  );
}

// ── Keyboard shortcuts ───────────────────────────────────────────

function openShortcuts() {
  document.getElementById("shortcuts-modal").style.display = "flex";
}
function closeShortcuts() {
  document.getElementById("shortcuts-modal").style.display = "none";
}

const MODAL_IDS = [
  "editor-modal",
  "confirm-modal",
  "prompt-modal",
  "scope-modal",
  "install-guide-modal",
  "shortcuts-modal",
  "replay-modal",
  "clients-modal",
  // Listed so it blocks shortcuts, but deliberately absent from the Esc cascade
  // below: dismissing a security prompt with a stray keypress, and leaving the
  // device hanging until it times out, is not a thing this dialog should allow.
  "access-modal",
];
const anyModalOpen = () =>
  MODAL_IDS.some((id) => document.getElementById(id)?.style.display === "flex");

const isOpen = (id) => document.getElementById(id)?.style.display === "flex";

// ── Shortcut hints ───────────────────────────────────────────────
// The labels themselves live in util.js, shared with the mocks empty state.

/**
 * Fill in every shortcut hint in the DOM: the `(⌘F)` suffix on the three search
 * placeholders, and the <kbd> keys in the help modal, whose `data-keys` reads
 * like `mod+F or /`.
 */
function initShortcutHints() {
  const find = combo("mod", "F");
  document.querySelectorAll("[data-hint-find]").forEach((input) => {
    // Keep the bare text around so this stays idempotent.
    const base = input.dataset.placeholderBase || input.placeholder;
    input.dataset.placeholderBase = base;
    input.placeholder = `${base} (${find})`;
  });

  document.querySelectorAll("[data-keys]").forEach((cell) => {
    cell.replaceChildren();
    cell.dataset.keys.split(" or ").forEach((alternative, i) => {
      if (i) cell.append(" or ");
      alternative.split("+").forEach((key, j) => {
        if (j) cell.append(" + ");
        const kbd = document.createElement("kbd");
        kbd.textContent = KEY_LABEL[key] || key;
        cell.append(kbd);
      });
    });
  });
}

// Which half of the workspace the user is working in. There are three search
// boxes on screen at once — the host filter, the request/response find, and the
// mock filter — so "search" has no meaning until you know which panel the user
// means. Where they last clicked is the only honest answer.
let _activePane = "left";

function initPaneTracking() {
  const track = (event) => {
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest("#pane-left")) _activePane = "left";
    else if (target.closest("#pane-right")) _activePane = "right";
  };
  // Capture phase: the tree and the inspector both use delegated listeners, and
  // this must not depend on them letting the event through.
  document.addEventListener("pointerdown", track, true);
  document.addEventListener("focusin", track, true);
}

/** The search box the find shortcut should land in, given where the user is. */
function contextualSearch() {
  if (_activePane === "right") {
    // Each full-pane view replaces the traffic view in the same pane and brings
    // its own filter — searching request bodies that aren't on screen would be
    // odd.
    const BY_MODE = { mocks: "mock-search", requests: "coll-search" };
    return document.getElementById(BY_MODE[state.inspectorMode] || "insp-search");
  }
  return document.getElementById("tree-search");
}

function focusContextualSearch() {
  const input = contextualSearch();
  if (!input) return;
  input.focus();
  // Select what's there so the next keystroke replaces the old query rather
  // than appending to it.
  input.select();
}

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const inEditor = isOpen("editor-modal");

    if ((e.ctrlKey || e.metaKey) && e.key === "s" && inEditor) {
      e.preventDefault();
      editor.saveMock();
      return;
    }

    if (e.key === "Escape") {
      // Ordered by how "on top" each layer is, so Escape always dismisses the
      // thing the user is actually looking at.
      if (isContextMenuOpen()) return closeContextMenu();
      if (isOpen("confirm-modal")) return resolveConfirm(false);
      // Above the editor: a prompt opened *from* the editor sits on top of it.
      if (isOpen("prompt-modal")) return resolvePrompt(null);
      if (isOpen("clients-modal")) return access.closeApprovedClients();
      if (isOpen("shortcuts-modal")) return closeShortcuts();
      if (isOpen("replay-modal")) return requestEditor.closeRequestEditor();
      if (inEditor) return editor.closeEditor();
      if (isOpen("install-guide-modal")) return certs.closeInstallGuide();
      if (isOpen("scope-modal")) return editor.closeScopeModal();
      if (state.inspectorMode === "mocks") return mocks.closeMocksView();
      if (state.inspectorMode === "requests") return collections.closeCollections();
      return;
    }

    // ⌘F → the search box of the panel you're working in, not find-in-page.
    // Deliberately ahead of the input guard: hitting it while already in one
    // search box should move you to the right one, not be swallowed.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      if (anyModalOpen()) return;
      e.preventDefault();
      focusContextualSearch();
      return;
    }

    // ⌘⌥N → new mock. Two shortcuts above this one never reached the page: ⌘N is
    // Chrome's File > New Window, and ⌘E was already claimed by a browser
    // extension. Both are resolved before the keydown is dispatched, so no
    // amount of preventDefault helps — only picking a free combination does.
    // `e.code`, not `e.key`: Option rewrites the character macOS reports (⌥N is
    // a dead key for the tilde), so `e.key` here is not "n".
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "KeyN") {
      if (anyModalOpen()) return;
      e.preventDefault();
      editor.createMock();
      return;
    }

    // ⌘⌥R → compose a request. Same modifier pair and the same `e.code` reason
    // as ⌘⌥N above; plain ⌘R is the browser's reload and never arrives.
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "KeyR") {
      if (anyModalOpen()) return;
      e.preventDefault();
      requestEditor.openComposer();
      return;
    }

    if (["INPUT", "TEXTAREA"].includes(e.target.tagName) || anyModalOpen()) return;

    if (e.key === "/") {
      e.preventDefault();
      focusContextualSearch();
    } else if (e.key === "?") {
      e.preventDefault();
      openShortcuts();
    }
  });
}

function initModalDismissal() {
  ["editor-modal", "shortcuts-modal"].forEach((id) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    let downOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      downOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (!downOnOverlay || e.target !== overlay) return;
      if (id === "editor-modal") editor.closeEditor();
      else closeShortcuts();
    });
  });

  document.addEventListener("click", (e) => {
    const wrapper = document.getElementById("settings-wrapper");
    if (wrapper && !wrapper.contains(e.target)) closeSettings();
  });
}

// ── Layout ───────────────────────────────────────────────────────

function initSplitters() {
  const root = document.documentElement;
  applyStoredPaneSizes(root);

  createSplitter({
    handle: document.getElementById("splitter-left"),
    root,
    name: "pane-left",
    axis: "x",
    unit: "px",
    min: 220,
    max: 560,
    defaultValue: "340px",
    measure: document.getElementById("workspace"),
  });

  createSplitter({
    handle: document.getElementById("splitter-hits"),
    root,
    name: "pane-hits",
    axis: "y",
    unit: "%",
    min: 10,
    max: 80,
    defaultValue: "34%",
    measure: document.getElementById("insp-traffic"),
    // Sizes itself to the hit list until you drag it, then your size wins.
    autoFit: true,
  });
}

/**
 * Send phones and tablets to the certificate guide; keep desktop users at a
 * narrow window on the dashboard with an overlay instead.
 *
 * The device check can't be done server-side alone: iPadOS 13+ sends a desktop
 * macOS user agent, so only `maxTouchPoints` gives it away.
 */
function initViewportGate() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("desktop") === "1") sessionStorage.setItem("ir-proxy.forceDesktop", "1");
  const forced = sessionStorage.getItem("ir-proxy.forceDesktop") === "1";

  const ua = navigator.userAgent;
  const isIpad = navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
  const isMobileUa = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  if (!forced && (isIpad || isMobileUa || coarse)) {
    window.location.replace("/install-guide.html");
    return;
  }

  const gate = document.getElementById("narrow-gate");
  const check = () => {
    if (gate) gate.hidden = window.innerWidth >= 1100;
  };
  window.addEventListener("resize", debounce(check, 150));
  check();
}

// ── Global handler bindings ──────────────────────────────────────
// Inline `on*` attributes resolve against `window`, so every handler a module
// exports gets bound here. New panels use delegated listeners instead and don't
// rely on this, but the surviving modals and the mock matrix do.

[
  access,
  certs,
  collections,
  editor,
  entries,
  hosts,
  inspector,
  mocks,
  panelSearch,
  requestEditor,
].forEach((mod) =>
  Object.entries(mod).forEach(([name, fn]) => {
    if (typeof fn === "function") window[name] = fn;
  })
);

Object.assign(window, {
  load,
  // `render` is up-called by mocks.js when it opens or closes its view —
  // same acyclic-by-window rule as `load`.
  render,
  saveProfile,
  loadProfile,
  deleteProfile,
  resolveConfirm,
  resolvePrompt,
  submitPrompt,
  openShortcuts,
  closeShortcuts,
  toggleStandalone,
  toggleLogPaused,
  updateSettings,
  renameInstance,
  submitAddInstance,
  toggleSettings,
  // Bound because access.js closes the popover when its modal opens, and
  // cross-module up-calls here go through `window` to stay acyclic.
  closeSettings,
  clearAllEntries,
});

window.handleSearch = debounce(mocks.handleSearch, 180);
window.handleCollectionSearch = debounce(collections.handleCollectionSearch, 120);
window.handleTreeSearch = debounce(hosts.handleTreeSearch, 120);

// ── Boot ─────────────────────────────────────────────────────────

window.onload = () => {
  initViewportGate();
  initSplitters();
  initShortcutHints();
  initPaneTracking();
  initKeyboardShortcuts();
  initModalDismissal();

  hosts.loadCollapsedSections();
  hosts.initTree();
  inspector.initInspector();
  mocks.initMocksMenu();
  collections.initCollections();
  initProfileList();
  certs.renderCertButton();

  // Not coalesced into the render loop: each of these is a device waiting on an
  // answer, and the queue picks up whatever arrived before this tab was open.
  entries.onAccessEvent(access.handleAccessEvent);
  entries.onNetworkEvent(handleNetworkChange);
  access.initAccess();

  // One coalesced repaint per frame, however many SSE messages arrive.
  entries.onDataChange(render);

  load();
  entries.fetchHosts();
  entries.fetchLogHistory();
  entries.connectSSE();

  updateHealth();
  setInterval(updateHealth, HEALTH_INTERVAL_MS);

  // Only while the mocks view is open, and only repainting when the numbers
  // moved. Watching a counter tick is the point; polling a screen nobody is
  // looking at is not.
  setInterval(() => {
    if (state.inspectorMode === "mocks") mocks.refreshMockStats();
  }, 2000);
};
