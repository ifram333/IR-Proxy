/**
 * contextmenu.js
 * ─────────────────────────────────────────────────────────────────────────────
 * A single reusable right-click menu.
 *
 * One menu element is created once and reused; items are rebuilt per open. It
 * is built from real DOM nodes with `textContent`, never an HTML string —
 * labels can embed a hostname or a path, both of which come off the wire and
 * neither of which is safe to interpolate into markup.
 *
 * Dismissal has to cover every way attention leaves the menu: another click,
 * Escape, scrolling the tree underneath it, resizing, or the window losing
 * focus. A menu left floating over stale content is worse than no menu.
 */

let _menu = null;
let _onClose = null;

function ensureMenu() {
  if (_menu) return _menu;

  _menu = document.createElement("div");
  _menu.className = "ctx-menu";
  _menu.setAttribute("role", "menu");
  _menu.hidden = true;
  document.body.appendChild(_menu);

  // `pointerdown` rather than `click`: closing on the way down means the menu
  // is gone before the underlying element sees the click.
  document.addEventListener("pointerdown", (event) => {
    if (_menu.hidden) return;
    if (!_menu.contains(event.target)) closeContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (_menu.hidden) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      closeContextMenu();
    }
  });
  window.addEventListener("blur", () => closeContextMenu());
  window.addEventListener("resize", () => closeContextMenu());
  // Capture phase so a scroll in any pane closes it, not just the document.
  window.addEventListener("scroll", () => closeContextMenu(), true);

  return _menu;
}

/** Hide the menu if it's open. */
export function closeContextMenu() {
  if (!_menu || _menu.hidden) return;
  _menu.hidden = true;
  _menu.innerHTML = "";
  const cb = _onClose;
  _onClose = null;
  if (cb) cb();
}

/**
 * Open the menu at the pointer.
 *
 * @param {MouseEvent} event
 * @param {Array<object>} items each `{ label, onSelect, danger?, disabled?,
 *   checked?, hint? }`, or `{ separator: true }`, or `{ heading: "…" }`
 * @param {object} [opts]
 * @param {() => void} [opts.onClose] called whenever the menu closes
 */
export function openContextMenu(event, items, opts = {}) {
  event.preventDefault();
  event.stopPropagation();

  const menu = ensureMenu();
  closeContextMenu();
  _onClose = opts.onClose || null;

  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      sep.setAttribute("role", "separator");
      menu.appendChild(sep);
      return;
    }

    if (item.heading) {
      const heading = document.createElement("div");
      heading.className = "ctx-heading";
      heading.textContent = item.heading;
      menu.appendChild(heading);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctx-item";
    button.setAttribute("role", "menuitem");
    if (item.danger) button.classList.add("danger");
    if (item.checked) button.classList.add("checked");
    if (item.disabled) button.disabled = true;

    const label = document.createElement("span");
    label.className = "ctx-label";
    label.textContent = item.label;
    button.appendChild(label);

    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      hint.textContent = item.hint;
      button.appendChild(hint);
    }

    button.addEventListener("click", () => {
      closeContextMenu();
      item.onSelect?.();
    });

    menu.appendChild(button);
  });

  // Measure off-screen, then place so the menu never hangs off the viewport.
  menu.hidden = false;
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const { width, height } = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(event.clientX, window.innerWidth - width - margin);
  const top = Math.min(event.clientY, window.innerHeight - height - margin);

  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
  menu.style.visibility = "visible";

  menu.querySelector(".ctx-item:not(:disabled)")?.focus();
}

/** Is the menu currently open? (the Escape cascade asks before consuming a key) */
export function isContextMenuOpen() {
  return Boolean(_menu) && !_menu.hidden;
}
