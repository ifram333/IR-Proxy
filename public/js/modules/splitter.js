/**
 * splitter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Mouse-draggable dividers between panes.
 *
 * The panes are CSS grid tracks sized by a custom property, so a drag writes
 * exactly one value (`--pane-left: 380px`) on the grid container. That reflows
 * the grid and nothing re-renders — no JS layout maths, no reading back element
 * widths, and the tree keeps its scroll position and selection while you drag.
 *
 * Pointer events (not mousedown/mousemove on document) because
 * `setPointerCapture` routes every subsequent move to the handle itself: the
 * drag survives the cursor crossing an iframe or leaving the window, and it
 * works for touch and pen without a second code path.
 */

const STORAGE_KEY = "ir-proxy.panes";

/** Read the persisted pane sizes. Never throws — a corrupt value just resets. */
export function loadPaneSizes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePaneSize(name, value) {
  try {
    const all = loadPaneSizes();
    all[name] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Private-mode or full storage: the drag still worked, it just won't stick.
  }
}

/**
 * Apply the persisted sizes before first paint so the layout doesn't jump.
 * @param {HTMLElement} root element carrying the custom properties
 */
export function applyStoredPaneSizes(root) {
  const stored = loadPaneSizes();
  Object.entries(stored).forEach(([name, value]) => {
    if (typeof value === "string" && /^[\d.]+(px|%)$/.test(value)) {
      root.style.setProperty(`--${name}`, value);
    }
    // A `<name>-manual` flag means the user has dragged this divider, so the
    // pane stops auto-sizing to its content and honours the size instead.
    if (value === true && name.endsWith("-manual")) {
      root.dataset[toDatasetKey(name)] = "1";
    }
  });
}

/** "pane-hits-manual" → "paneHitsManual", to match `dataset` naming. */
function toDatasetKey(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Wire up one divider.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.handle      the divider element
 * @param {HTMLElement} opts.root        element the custom property is set on
 * @param {string}      opts.name        custom property name, without the `--`
 * @param {"x"|"y"}     opts.axis        drag direction
 * @param {string}      opts.unit        "px" or "%"
 * @param {number}      opts.min
 * @param {number}      opts.max
 * @param {string}      opts.defaultValue restored on double-click
 * @param {HTMLElement} [opts.measure]   element the % is measured against
 * @param {boolean}     [opts.autoFit]   the pane shrinks to its content until
 *   the user drags this divider, after which their size wins. Without the
 *   hand-off the drag silently does nothing whenever the content is smaller
 *   than the track.
 */
export function createSplitter({
  handle,
  root,
  name,
  axis = "x",
  unit = "px",
  min,
  max,
  defaultValue,
  measure,
  autoFit = false,
}) {
  if (!handle || !root) return;

  const manualKey = `${name}-manual`;
  const clamp = (value) => Math.min(max, Math.max(min, value));

  /** Hand control from auto-fit to the user, permanently. */
  const takeManualControl = () => {
    if (!autoFit || root.dataset[toDatasetKey(manualKey)]) return;
    root.dataset[toDatasetKey(manualKey)] = "1";
    savePaneSize(manualKey, true);
  };

  const setValue = (value, persist) => {
    const next = `${Math.round(clamp(value) * 100) / 100}${unit}`;
    root.style.setProperty(`--${name}`, next);
    handle.setAttribute("aria-valuenow", String(Math.round(clamp(value))));
    if (persist) savePaneSize(name, next);
  };

  /** Where the pointer sits, expressed in this splitter's unit. */
  const valueFromPointer = (event) => {
    const box = (measure || root).getBoundingClientRect();
    const offset = axis === "x" ? event.clientX - box.left : event.clientY - box.top;
    if (unit === "%") {
      const total = axis === "x" ? box.width : box.height;
      return total ? (offset / total) * 100 : min;
    }
    return offset;
  };

  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(max));
  if (!handle.hasAttribute("tabindex")) handle.setAttribute("tabindex", "0");

  handle.addEventListener("pointerdown", (event) => {
    // Ignore right/middle clicks so a context menu doesn't start a drag.
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    // Suppress text selection and stop pointer events reaching the panes (an
    // embedded editor would otherwise swallow the moves).
    document.body.classList.add("resizing");
    handle.classList.add("dragging");
  });

  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    // Hand over on the first move, not on release, so the pane follows the
    // cursor straight away instead of jumping into place at the end.
    takeManualControl();
    setValue(valueFromPointer(event), false);
  });

  const endDrag = (event) => {
    if (!handle.hasPointerCapture?.(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing");
    handle.classList.remove("dragging");
    setValue(valueFromPointer(event), true);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  // Keyboard nudging — a divider you can only reach with a mouse is a divider
  // some people simply cannot move.
  handle.addEventListener("keydown", (event) => {
    const step = unit === "%" ? 2 : 16;
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const forward = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();

    const current = parseFloat(
      getComputedStyle(root).getPropertyValue(`--${name}`) || defaultValue
    );
    takeManualControl();
    setValue(current + (event.key === forward ? step : -step), true);
  });

  // Double-click resets — including handing control back to auto-fit, so this
  // is also the way out if you've sized the pane into a corner.
  handle.addEventListener("dblclick", () => {
    root.style.setProperty(`--${name}`, defaultValue);
    savePaneSize(name, defaultValue);
    if (autoFit) {
      delete root.dataset[toDatasetKey(manualKey)];
      savePaneSize(manualKey, false);
    }
  });
}
