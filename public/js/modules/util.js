/**
 * Low-level helpers: URL building, fetch wrapper, toasts, and the confirm modal.
 * This module has no dependencies other than shared state.
 */
import { state } from "./state.js";

export function getApiUrl(p) {
  const origin = window.location.origin === "null" ? "" : window.location.origin;
  return origin + p;
}

export function pathBasename(str) {
  return str.split(/[\\/]/).pop();
}

// ── HTML escaping ────────────────────────────────────────────────
// Escape server/user-supplied values before interpolating them into
// innerHTML — covers element-text and single/double-quoted attribute
// contexts. Use this for any value that isn't a hard-constrained token
// (e.g. instance `name`, which a client controls via POST /__admin/instances).
const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// ── Scroll lock ──────────────────────────────────────────────────
// Full-screen overlays whose visibility should freeze background scrolling.
const SCROLL_LOCK_MODALS = ["editor-modal", "log-detail-modal"];

/**
 * Toggle `body.modal-open` (overflow: hidden) based on whether any tracked
 * overlay is currently shown. Call after opening or closing one of them.
 */
export function syncScrollLock() {
  const anyOpen = SCROLL_LOCK_MODALS.some(
    (id) => document.getElementById(id)?.style.display === "flex"
  );
  document.body.classList.toggle("modal-open", anyOpen);
}

export function decodeAndParse(encoded) {
  return JSON.parse(decodeURIComponent(encoded));
}

/**
 * Trailing-edge debounce — used to keep full re-renders off the keystroke
 * path of the search inputs.
 */
export function debounce(fn, ms = 180) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── Clipboard ────────────────────────────────────────────────────
/**
 * Copy text to the clipboard, falling back to a hidden textarea +
 * execCommand for insecure contexts (e.g. localhost without https).
 */
export function copyText(text, successMessage = "Copied to clipboard!") {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast(successMessage))
      .catch((err) => toast("Failed to copy: " + err, "error"));
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand("copy");
    toast(successMessage);
  } catch {
    toast("Failed to copy. Please copy manually.", "error");
  }
  document.body.removeChild(textArea);
}

export async function api(url, opts = {}) {
  const res = await fetch(getApiUrl(url), {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

// ── Toast Notifications ──────────────────────────────────────────
export function toast(message, type = "success") {
  const icons = { success: "✅", error: "❌", info: "ℹ️", warning: "⚠️" };
  const el = document.createElement("div");
  el.className = `toast ${type}`;

  // Built as DOM, not innerHTML. Toasts now carry hostnames and server error
  // messages that quote them, and a hostname is whatever a device asked the
  // proxy for — not something this process chose. Escaping at each call site
  // would mean never missing one; doing it here means it can't be missed.
  const icon = document.createElement("span");
  icon.textContent = icons[type] || "💬";
  const text = document.createElement("span");
  text.textContent = message;
  el.append(icon, text);
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => {
    el.classList.add("fade-out");
    el.addEventListener("animationend", () => el.remove());
  }, 3500);
}

// ── Confirm Modal ────────────────────────────────────────────────
export function showConfirm(message) {
  document.getElementById("confirm-message").textContent = message;
  document.getElementById("confirm-modal").style.display = "flex";
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
  });
}
export function resolveConfirm(result) {
  document.getElementById("confirm-modal").style.display = "none";
  if (state.confirmResolve) {
    state.confirmResolve(result);
    state.confirmResolve = null;
  }
}

// ── Prompt Modal ─────────────────────────────────────────────────
// Replaces the native `prompt()`. Three reasons, in order of how much they hurt:
// it blocks the whole renderer while it is open (the create-mock one froze the
// tab), it can't validate, and it looks like nothing else here.

/**
 * Ask for a single line of text.
 *
 * `validate(value)` runs on every keystroke. Return:
 *   • a string       → a problem; shown in red, confirm disabled
 *   • `{ warning }`  → worth saying, not worth blocking (e.g. "this overwrites
 *                      an existing profile") — shown in amber, confirm enabled
 *   • anything falsy → fine
 *
 * That distinction matters: an overwrite is a legitimate thing to want, and a
 * validator that could only block would have made it impossible.
 *
 * @returns {Promise<string|null>} the trimmed value, or null if cancelled
 */
export function showPrompt({
  title = "",
  label = "",
  value = "",
  placeholder = "",
  confirmLabel = "OK",
  validate = null,
} = {}) {
  const input = document.getElementById("prompt-input");
  const error = document.getElementById("prompt-error");
  const confirm = document.getElementById("prompt-confirm");

  document.getElementById("prompt-title").textContent = title;
  document.getElementById("prompt-label").textContent = label;
  confirm.textContent = confirmLabel;
  input.value = value;
  input.placeholder = placeholder;

  const check = () => {
    const result = validate ? validate(input.value.trim()) : "";
    const blocking = typeof result === "string" && result !== "";
    const message = blocking ? result : result?.warning || "";
    error.textContent = message;
    error.classList.toggle("warning", !blocking && Boolean(message));
    confirm.disabled = blocking;
    return !blocking;
  };
  check();

  input.oninput = check;
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (check()) resolvePrompt(input.value.trim());
    }
    // Escape falls through to the global cascade in dashboard.js; the rest is
    // stopped so typing an "n" doesn't also fire a shortcut.
    event.stopPropagation();
  };

  document.getElementById("prompt-modal").style.display = "flex";
  // After layout, or focus() lands on a display:none element and is dropped.
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  return new Promise((resolve) => {
    state.promptResolve = resolve;
  });
}

/** Close the prompt, handing `result` (or null) back to the awaiting caller. */
export function resolvePrompt(result) {
  const modal = document.getElementById("prompt-modal");
  if (modal) modal.style.display = "none";
  const input = document.getElementById("prompt-input");
  if (input) {
    input.oninput = null;
    input.onkeydown = null;
  }
  if (state.promptResolve) {
    state.promptResolve(result === undefined ? null : result);
    state.promptResolve = null;
  }
}

/** The confirm button. A no-op while the value is invalid. */
export function submitPrompt() {
  if (document.getElementById("prompt-confirm")?.disabled) return;
  resolvePrompt(document.getElementById("prompt-input")?.value.trim() || null);
}

// ── Keyboard labels ──────────────────────────────────────────────
// The keys are the same everywhere; only their names differ. Writing "⌘" into
// the markup meant a Windows user read a symbol their keyboard doesn't have.
//
// Here rather than in dashboard.js because two places render shortcut names —
// the help modal and the mocks empty state — and the last time they had their
// own spellings one of them still said ⌘N long after that binding had moved.

// Case-insensitive on purpose: the two sources disagree on capitalisation —
// userAgentData says "macOS", the legacy field says "MacIntel".
//
// Read off `globalThis` rather than the bare global: this runs at import time,
// and Jest imports this module (through panel-search.js) in plain Node, where
// `navigator` has no `platform`. A bare reference would throw there and take a
// test file with it — for a constant that only decides whether to print ⌘.
const IS_MAC = /mac|iphone|ipad/i.test(
  globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || ""
);

export const KEY_LABEL = IS_MAC ? { mod: "⌘", alt: "⌥" } : { mod: "Ctrl", alt: "Alt" };

/**
 * Render a key combination for this platform.
 *
 * Mac stacks its modifier glyphs (⌘⌥N); everywhere else they're spelled out and
 * need separators (Ctrl+Alt+N).
 */
export const combo = (...keys) =>
  keys.map((k) => KEY_LABEL[k] || k).join(IS_MAC ? "" : "+");

/**
 * Re-key a captured header map with the spelling the client actually used.
 *
 * A log entry's `requestHeaders` is lowercase — that is Node's parse of the
 * request, and it is what mocks match on and what the capture clients read — so
 * the original spellings ride along separately in `requestHeaderCase`. Anything
 * that shows a reader what was *sent* joins them back up here: the inspector's
 * header list, its cURL copy, and the replay editor's prefill. A name with no
 * entry keeps whatever it had, so this is safe over a merged map.
 *
 * The backend has the same pair in `utils/header-case.js`, where the replay
 * route needs it; `public/js` has no build step and cannot import CommonJS.
 */
export function withHeaderCase(headers, names) {
  if (!headers) return {};
  // Always a copy: callers strip hop-by-hop names out of the result.
  if (!names) return { ...headers };
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      names[key.toLowerCase()] || key,
      value,
    ])
  );
}
