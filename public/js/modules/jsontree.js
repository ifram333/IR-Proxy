/**
 * Collapsible, type-colored JSON tree renderer for the log detail modal.
 * No third-party dependency: content here can include auth headers/tokens
 * from proxied traffic, so everything is built as real DOM nodes via
 * `.textContent` — never `innerHTML` on log content.
 */
import { copyText } from "./util.js";

const COLLAPSE_AT_DEPTH = 2; // depth 0 & 1 start expanded; deeper nodes start collapsed

/**
 * Render a header/body value (object, JSON string, or plain string) as a
 * DOM tree (or a plain-text fallback for non-JSON content).
 * @returns {{ el: HTMLElement, raw: string|null, isEmpty: boolean }}
 */
export function renderValue(value, { emptyLabel = "Nothing to show" } = {}) {
  if (value == null || value === "") {
    const el = document.createElement("div");
    el.className = "jt-empty";
    el.textContent = emptyLabel;
    return { el, raw: null, isEmpty: true };
  }

  let data;
  let raw;
  if (typeof value === "object") {
    data = value;
    raw = JSON.stringify(value, null, 2);
  } else if (typeof value === "string") {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      data = parsed;
      raw = JSON.stringify(parsed, null, 2);
    } else {
      raw = value; // plain text / HTML / truncated JSON — shown as-is
    }
  } else {
    data = value;
    raw = String(value);
  }

  if (data === undefined) {
    const pre = document.createElement("pre");
    pre.className = "jt-plain jt-leaf-text";
    pre.textContent = raw;
    return { el: pre, raw, isEmpty: false };
  }

  const root = document.createElement("div");
  root.className = "jt-root";
  buildChildren(root, data, 0);
  return { el: root, raw, isEmpty: false };
}

function buildChildren(parentEl, data, depth) {
  const entries = Array.isArray(data)
    ? data.map((v, i) => [String(i), v])
    : Object.entries(data);
  entries.forEach(([key, val]) => parentEl.appendChild(buildNode(key, val, depth)));
}

function buildNode(key, val, depth) {
  const node = document.createElement("div");
  node.className = "jt-node";

  const row = document.createElement("div");
  row.className = "jt-row";
  node.appendChild(row);

  const isContainer =
    val !== null && typeof val === "object" && Object.keys(val).length > 0;

  if (isContainer) {
    const toggle = document.createElement("button");
    toggle.className = "jt-toggle";
    toggle.type = "button";
    toggle.textContent = "▾";
    toggle.setAttribute("aria-label", "Toggle expand");
    toggle.addEventListener("click", () => node.classList.toggle("collapsed"));
    row.appendChild(toggle);
    if (depth >= COLLAPSE_AT_DEPTH) node.classList.add("collapsed");
  } else {
    const spacer = document.createElement("span");
    spacer.className = "jt-toggle-spacer";
    row.appendChild(spacer);
  }

  const keyEl = document.createElement("span");
  keyEl.className = "jt-key jt-leaf-text";
  keyEl.textContent = key;
  row.appendChild(keyEl);
  const colon = document.createElement("span");
  colon.className = "jt-colon";
  colon.textContent = ":";
  row.appendChild(colon);

  const isObjectLike = val !== null && typeof val === "object";
  if (isObjectLike) {
    const isArr = Array.isArray(val);
    const count = Object.keys(val).length;
    const summary = document.createElement("span");
    summary.className = "jt-summary";
    summary.textContent = isArr ? `[${count}]` : `{${count}}`;
    row.appendChild(summary);
    row.appendChild(makeCopyBtn(() => JSON.stringify(val, null, 2)));

    if (count > 0) {
      const children = document.createElement("div");
      children.className = "jt-children";
      buildChildren(children, val, depth + 1);
      node.appendChild(children);
    }
  } else {
    const valEl = document.createElement("span");
    valEl.className = `jt-val jt-leaf-text jt-type-${typeTag(val)}`;
    valEl.textContent = displayText(val);
    row.appendChild(valEl);
    row.appendChild(makeCopyBtn(() => (val === null ? "null" : String(val))));
  }

  return node;
}

function typeTag(v) {
  if (v === null) return "null";
  return typeof v; // "string" | "number" | "boolean"
}
function displayText(v) {
  return v === null ? "null" : typeof v === "string" ? `"${v}"` : String(v);
}
function makeCopyBtn(getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "jt-copy-btn";
  btn.textContent = "⧉";
  btn.title = "Copy value";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyText(getText(), "Value copied!");
  });
  return btn;
}

/** Reveal a node buried in collapsed ancestors (used by search). */
export function expandAncestors(el) {
  let node = el.closest(".jt-node");
  while (node) {
    node.classList.remove("collapsed");
    node = node.parentElement?.closest(".jt-node") ?? null;
  }
}
