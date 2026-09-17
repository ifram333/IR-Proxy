/**
 * Mock management: the Ace code editor, mock-file CRUD, and drag-and-drop
 * (moving a mock into a folder via rename).
 *
 * After any mutation we refresh the dashboard with `window.load()` — `load`
 * lives in the entry module and is bound to `window`, so calling it this way
 * avoids an import cycle.
 */
import { state } from "./state.js";
import {
  api,
  toast,
  getApiUrl,
  showConfirm,
  showPrompt,
  pathBasename,
  syncScrollLock,
  escapeHtml,
} from "./util.js";

// ── Ace Editor (lazy-loaded) ─────────────────────────────────────
const ACE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.2/ace.js";
let _aceLoader = null; // memoized <script> load promise

/**
 * Lazily load the Ace library (only the first time the editor is needed) and
 * build the editor instance. Safe to call repeatedly: the script is fetched
 * once and the editor created once. Resolves with the editor instance.
 */
/**
 * Resolve once the Ace library itself is available.
 *
 * Separate from `ensureEditor` because that one is bound to `#code-editor` and
 * memoizes a single instance; the replay editor needs its own. Loading the
 * script stays in one place either way.
 */
export function ensureAce() {
  if (!_aceLoader) {
    _aceLoader =
      typeof ace !== "undefined"
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = ACE_CDN;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error("Failed to load the code editor"));
            document.head.appendChild(s);
          });
  }
  return _aceLoader;
}

export function ensureEditor() {
  if (state.aceEditor) return Promise.resolve(state.aceEditor);

  return ensureAce().then(() => {
    if (!state.aceEditor) {
      state.aceEditor = ace.edit("code-editor");
      state.aceEditor.setTheme("ace/theme/monokai");
      state.aceEditor.session.setMode("ace/mode/javascript");
      state.aceEditor.setOptions({
        fontSize: "14px",
        showPrintMargin: false,
        useWorker: false,
        highlightActiveLine: true,
        wrap: true,
      });
    }
    return state.aceEditor;
  });
}

export async function openEditor(file) {
  let editor;
  try {
    editor = await ensureEditor();
  } catch (err) {
    toast(err.message || "Failed to load the code editor", "error");
    return;
  }
  state.currentFile = file;
  document.getElementById("editing-filename").innerText = `Editing: ${file}`;
  const res = await fetch(
    getApiUrl(`/__admin/mock-content?file=${encodeURIComponent(file)}`)
  );
  const data = await res.json();
  editor.setValue(data.content, -1);
  state.editorBaseline = editor.getValue(); // mark as clean
  document.getElementById("editor-modal").style.display = "flex";
  syncScrollLock();
}

export async function saveMock() {
  const res = await api("/__admin/save-mock", {
    method: "POST",
    body: { file: state.currentFile, content: state.aceEditor.getValue() },
  });
  if (res.ok) {
    toast("Mock saved & hot-reloaded");
    state.editorBaseline = state.aceEditor.getValue(); // now clean
    closeEditor();
    window.load();
  } else toast("Save failed: " + (await res.text()), "error");
}

/** True when the editor is open and its contents differ from the last save. */
export function isEditorDirty() {
  return !!state.aceEditor && state.aceEditor.getValue() !== state.editorBaseline;
}

export async function closeEditor() {
  // Warn before discarding unsaved edits (covers the Discard button, Esc, and
  // clicking outside the modal).
  if (isEditorDirty()) {
    const ok = await showConfirm(
      "You have unsaved changes. Close the editor without saving them?"
    );
    if (!ok) return;
  }
  document.getElementById("editor-modal").style.display = "none";
  syncScrollLock();
}

// ── Mock CRUD ─────────────────────────────────────────────────────

/** The file a typed path will become. `auth/login` → `auth/login.mock.js`. */
export const mockFileFor = (value) =>
  value.endsWith(".mock.js") ? value : `${value}.mock.js`;

/**
 * Why a mock path can't be used, or "" when it can.
 *
 * Runs on every keystroke, so it answers the two questions the server would
 * otherwise answer by failing: is this a legal path, and is it already taken?
 * The collision check is the valuable half — that used to cost a round trip and
 * arrive after the dialog had closed.
 *
 * @param {string} value        what the user has typed
 * @param {string|null} ignore  a file that may collide (renaming onto itself)
 */
export function validateMockPath(value, ignore = null) {
  if (!value) return "";
  if (value.startsWith("/"))
    return "Drop the leading slash — this is relative to mocks/.";
  if (value.endsWith("/")) return "Add a file name after the last slash.";
  if (value.includes("//")) return "Two slashes in a row.";
  // Blocked server-side too (safePath), but saying so here beats a 400.
  if (/(^|\/)\.\.(\/|$)/.test(value)) return "“..” isn't allowed.";
  // eslint-disable-next-line no-control-regex -- control chars are rejected on purpose
  if (/[<>:"|?*\\\x00-\x1f]/.test(value)) return 'Avoid < > : " | ? * \\ in file names.';

  const file = mockFileFor(value);
  const taken = (state.cachedData?.mocks || []).some(
    (m) => m.file === file && m.file !== ignore
  );
  if (taken) return `${file} already exists.`;
  return "";
}

export async function createMock() {
  const name = await showPrompt({
    title: "✨ New mock",
    label: "Path and name, relative to mocks/ — e.g. auth/login",
    placeholder: "auth/login",
    confirmLabel: "Create",
    validate: (value) => validateMockPath(value),
  });
  if (!name) return;
  const res = await api("/__admin/create-mock", { method: "POST", body: { name } });
  if (res.ok) {
    toast("Mock created ✨");
    window.load();
  } else toast("Create failed: " + (await res.text()), "error");
}

export async function renameMock(oldName) {
  const current = oldName.replace(/\.mock\.js$/, "");
  const newName = await showPrompt({
    title: "✏️ Rename mock",
    label: "New path and name, relative to mocks/",
    value: current,
    placeholder: "auth/login",
    confirmLabel: "Rename",
    // Its own file isn't a collision.
    validate: (value) => validateMockPath(value, oldName),
  });
  if (!newName || newName === current) return;
  const res = await api("/__admin/rename-mock", {
    method: "POST",
    body: { oldName, newName },
  });
  if (res.ok) {
    toast("Mock renamed");
    window.load();
  } else toast("Rename failed: " + (await res.text()), "error");
}

export async function deleteMock(file) {
  const ok = await showConfirm(`Permanently delete "${file}"?`);
  if (!ok) return;
  const res = await api("/__admin/delete-mock", { method: "POST", body: { file } });
  if (res.ok) {
    toast("Mock deleted", "info");
    window.load();
  } else toast("Delete failed: " + (await res.text()), "error");
}

export async function duplicateMock(file) {
  const res = await api("/__admin/duplicate-mock", { method: "POST", body: { file } });
  if (res.ok) {
    const { newFile } = await res.json();
    toast(`Duplicated as ${pathBasename(newFile)}`);
    window.load();
  } else toast("Duplicate failed: " + (await res.text()), "error");
}

// ── Drag & Drop (move a mock into a folder) ──────────────────────
export function handleDragStart(e, file) {
  e.dataTransfer.setData("text/plain", file);
  e.currentTarget.classList.add("dragging");
  // A cancelled drag fires `dragend` and nothing else, so without this the row
  // stayed faded until the next repaint — which, if you cancelled, never came.
  e.currentTarget.addEventListener(
    "dragend",
    (event) => event.currentTarget.classList.remove("dragging"),
    { once: true }
  );
}
export function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add("drag-over");
}
export function handleDragLeave(e) {
  e.currentTarget.classList.remove("drag-over");
}
export async function handleDrop(e, targetFolder) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  const file = e.dataTransfer.getData("text/plain");
  const basename = pathBasename(file);
  const newPath =
    targetFolder === "Root" || targetFolder === "."
      ? basename
      : `${targetFolder}/${basename}`;
  if (file === newPath) return;
  const res = await api("/__admin/rename-mock", {
    method: "POST",
    body: { oldName: file, newName: newPath },
  });
  if (res.ok) {
    toast("Mock moved");
    window.load();
  } else toast("Move failed: " + (await res.text()), "error");
}

// ── Server scope ─────────────────────────────────────────────────
// Open the modal to choose which servers a mock applies to. A mock with no
// scope (servers === null) applies to all servers, so every box starts checked.
export function openScopeEditor(file, name) {
  const data = state.cachedData;
  if (!data) return;
  const mock = data.mocks.find((m) => m.file === file && m.name === name);
  if (!mock) return;

  state.scopeEditTarget = { file, name };
  document.getElementById("scope-title").textContent = `🎯 Scope: ${name}`;

  const scoped = mock.servers; // array of ids, or null = all servers
  document.getElementById("scope-server-list").innerHTML = data.instances
    .map((i) => {
      const checked = !scoped || scoped.includes(i.id) ? "checked" : "";
      // Escaped: an instance promoted from a discovered host takes the
      // hostname as its name, and hostnames come off the wire.
      return `
      <label class="scope-server-item">
        <input type="checkbox" value="${escapeHtml(i.id)}" ${checked} />
        <span class="scope-server-name">${escapeHtml(i.name || "")}</span>
        <span class="scope-server-id">${escapeHtml(i.id)}</span>
      </label>`;
    })
    .join("");

  document.getElementById("scope-modal").style.display = "flex";
}

export async function saveScope() {
  const target = state.scopeEditTarget;
  if (!target) return;

  const ids = [...document.querySelectorAll("#scope-server-list input:checked")].map(
    (el) => el.value
  );
  if (ids.length === 0) {
    toast("Select at least one server", "warning");
    return;
  }

  // The backend treats a full selection as "all servers" (clears the field).
  const res = await api("/__admin/mock-scope", {
    method: "POST",
    body: { file: target.file, name: target.name, servers: ids },
  });
  if (res.ok) {
    toast("Scope updated");
    closeScopeModal();
    window.load();
  } else toast("Failed to update scope: " + (await res.text()), "error");
}

export function closeScopeModal() {
  document.getElementById("scope-modal").style.display = "none";
  state.scopeEditTarget = null;
}
