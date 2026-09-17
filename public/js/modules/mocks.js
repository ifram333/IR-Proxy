/**
 * mocks.js — the mock matrix.
 *
 * Two views off one renderer: a single host's column, opened from the tree's
 * right-click menu, and the full cross-host matrix ("All mocks"), which is how
 * you compare the same mock across environments at a glance.
 *
 * This is the one panel that still uses the **inline `onclick` → `window`**
 * convention rather than a delegated listener, and deliberately so: the table is
 * rebuilt wholesale on every toggle, and everything interpolated into it is a
 * mock name or a file path from disk — names this project controls, not
 * hostnames off the wire. The tree and the inspector, which do render network
 * data, use delegated listeners for exactly that reason. Every handler here is
 * bound onto `window` by dashboard.js's binding loop.
 *
 * The bulk actions are the exception: they live on a **delegated** contextmenu
 * listener, because a right-click target can't carry node identity through an
 * inline attribute.
 *
 * Up-calls to the entry module go through `window` (`load`, `render`,
 * `closeSettings`) to keep the module graph acyclic — the same rule editor.js
 * follows.
 */
import { state } from "./state.js";
import {
  getApiUrl,
  api,
  toast,
  showConfirm,
  decodeAndParse,
  pathBasename,
  escapeHtml,
  combo,
} from "./util.js";
import { setHostSsl } from "./entries.js";
import { openContextMenu } from "./contextmenu.js";

// ── Mocks views ──────────────────────────────────────────────────

/** Per-host mocks, opened from a host's right-click menu. */
export function renderHostMocks() {
  const data = state.cachedData;
  if (!data) return;

  const host = state.mocksHost;
  const instanceId = state.mocksInstanceId;
  const record = state.hosts.find((h) => h.host === host);

  document.getElementById("mocks-title").textContent = host ? "Mocks" : "All mocks";
  document.getElementById("mocks-sub").textContent = host || "Every host, side by side";

  // A host that isn't decrypted can never run a mock. Without this banner the
  // toggles look functional and simply do nothing.
  const banner = document.getElementById("mocks-ssl-banner");
  const needsSsl = Boolean(host) && !record?.ssl;
  banner.hidden = !needsSsl;
  if (needsSsl) {
    document.getElementById("mocks-enable-ssl").onclick = async () => {
      await setHostSsl(host, true);
      await window.load?.();
    };
  }

  // A host nobody has enabled has no instance behind it, so there is no column
  // to render. Falling through to the full matrix here would be actively
  // misleading: the header names one host while the grid shows every other.
  if (host && !instanceId) {
    document.getElementById("b-row").innerHTML = `<tr class="empty-row"><td colspan="1">
         No mock pipeline for this host yet — enable SSL proxying above and one
         is created for it.
       </td></tr>`;
    document.getElementById("h-row").innerHTML = `<th>Mock Definition</th>`;
    document.getElementById("results-count").textContent = "";
    return;
  }

  // With a host selected we show that host's column only; otherwise the full
  // cross-host matrix, which is how you compare toggles at a glance.
  renderMockTable(data, "b-row", "results-count", host ? instanceId : null);
}

// ── Mock hit counts ──────────────────────────────────────────────
// Kept out of /__admin/config: that payload already carries the whole mock
// registry and is refetched on every repaint, while these are small and move on
// a different rhythm.

let _mockStatsAt = 0;

/**
 * Pull the counters, repainting only when they actually changed.
 *
 * The change check is what stops this from looping: the repaint it triggers
 * runs through the mocks view again, which would ask for them again.
 */
export async function refreshMockStats(force = false) {
  if (!force && Date.now() - _mockStatsAt < 2000) return;
  _mockStatsAt = Date.now();
  try {
    const { stats } = await fetch(getApiUrl("/__admin/mock-stats")).then((r) => r.json());
    const next = JSON.stringify(stats);
    if (next === JSON.stringify(state.mockStats)) return;
    state.mockStats = stats;
    if (state.inspectorMode === "mocks") renderHostMocks();
  } catch {
    // Keep the last known counts rather than blanking the column.
  }
}

export async function resetMockStats(instanceId) {
  const label = instanceId ? `for ${instanceId}` : "for every host";
  const ok = await showConfirm(`Reset the mock hit counts ${label}?`);
  if (!ok) return;
  await api("/__admin/mock-stats/reset", { method: "POST", body: { instanceId } });
  await refreshMockStats(true);
  toast("Hit counts reset", "info");
}

export function openAllMocks() {
  state.inspectorMode = "mocks";
  state.mocksHost = null;
  state.mocksInstanceId = null;
  window.closeSettings?.();
  refreshMockStats(true);
  window.render?.();
}

export function closeMocksView() {
  state.inspectorMode = "traffic";
  window.render?.();
}

// A mock applies to an instance when it has no scope or lists that instance id.
function mockInScope(mock, instanceId) {
  return !mock.servers || mock.servers.includes(instanceId);
}
function scopeLabel(mock) {
  return mock.servers && mock.servers.length ? mock.servers.join(", ") : "All";
}

function renderMockTable(data, tbodyId, countId, filterServerId) {
  const scoped = filterServerId
    ? data.mocks.filter((m) => mockInScope(m, filterServerId))
    : data.mocks;

  const filtered = state.searchTerm
    ? scoped.filter(
        (m) =>
          m.name.toLowerCase().includes(state.searchTerm) ||
          m.file.toLowerCase().includes(state.searchTerm)
      )
    : scoped;

  const countEl = document.getElementById(countId);
  if (countEl) countEl.innerText = `${filtered.length} mocks`;

  const colInstances = filterServerId
    ? data.instances.filter((i) => i.id === filterServerId)
    : data.instances;

  // Header row: one column per instance in view. `data-instance` is what the
  // right-click menu reads — see initMocksMenu.
  const headRow = document.getElementById("h-row");
  if (headRow) {
    headRow.innerHTML =
      `<th>Mock Definition</th>` +
      colInstances
        .map(
          (i) =>
            `<th class="inst-col mocks-host-head" data-instance="${escapeHtml(i.id)}"
                 title="Right-click for bulk actions">${escapeHtml(i.name || i.id)}</th>`
        )
        .join("");
  }

  if (filtered.length === 0) {
    const colspan = colInstances.length + 1;
    const message = state.searchTerm
      ? `No mocks match “${escapeHtml(state.searchTerm)}”.
         <button class="btn btn-ghost btn-sm" onclick="clearMockSearch()">Clear search</button>`
      : // Built from the same table as the shortcuts modal, so it can't drift
        // again — this said ⌘N long after the binding moved.
        `No mocks yet — create one with “+ New Mock” (${combo("mod", "alt", "N")}).`;
    document.getElementById(tbodyId).innerHTML =
      `<tr class="empty-row"><td colspan="${colspan}">${message}</td></tr>`;
    return;
  }

  const groups = filtered.reduce((acc, m) => {
    const f = m.folder || "Root";
    if (!acc[f]) acc[f] = [];
    acc[f].push(m);
    return acc;
  }, {});

  const sortedFolders = Object.keys(groups).sort((a, b) =>
    a === "Root" ? -1 : b === "Root" ? 1 : a.localeCompare(b)
  );

  let html = "";
  sortedFolders.forEach((folder) => {
    const mockNames = encodeURIComponent(
      JSON.stringify(groups[folder].map((m) => m.name))
    );

    // The bulk ON/OFF pairs used to be rendered inline here — two buttons per
    // host per folder, which is fourteen buttons a row once you have seven
    // hosts. They live in the right-click menu now (initMocksMenu).
    html += `
      <tr class="folder-header" data-folder="${escapeHtml(folder)}" data-mocks="${mockNames}"
          ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event,'${folder}')">
        <td colspan="${colInstances.length + 1}">
          <div class="folder-header-inner">
            <span class="folder-label">📁 ${folder}</span>
            <span class="folder-hint">right-click for bulk actions</span>
          </div>
        </td>
      </tr>`;

    groups[folder].forEach((m) => {
      const badges = [
        m.hasConflict ? `<span class="badge badge-conflict">⚠ CONFLICT</span>` : "",
        m.delay > 0 ? `<span class="badge badge-delay">⏱ ${m.delay}ms</span>` : "",
      ].join("");

      const instanceCols = colInstances
        .map((i) => {
          const activeCol = i.id === data.currentInstanceId ? "active-col" : "";
          if (!mockInScope(m, i.id)) {
            return `<td class="inst-col ${activeCol} not-applicable" data-label="${escapeHtml(i.name)}" title="Not applicable to ${escapeHtml(i.name)}">—</td>`;
          }
          const on = data.states[i.id]?.[m.name] === true;
          const isOff = !data.instanceSettings[i.id]?.isActive;

          // "Did it fire?" — the question this screen couldn't answer. A count
          // when it has; a muted dash when it's on and hasn't, which is the
          // state actually worth spotting: enabled, in scope, and never hit.
          const hit = state.mockStats?.[i.id]?.[m.name];
          const fired = hit
            ? `<span class="hit-count" title="Answered ${hit.count} request${hit.count === 1 ? "" : "s"}, last at ${escapeHtml(new Date(hit.lastAt).toLocaleString())}">${hit.count}</span>`
            : on && !isOff
              ? `<span class="hit-count none" title="Enabled, but it hasn't answered anything yet">·</span>`
              : `<span class="hit-count blank"></span>`;

          return `
          <td class="inst-col ${activeCol} ${isOff ? "inst-off" : ""}" data-label="${escapeHtml(i.name)}">
            <div class="inst-cell">
              <label class="switch">
                <input type="checkbox" ${on ? "checked" : ""} ${isOff ? "disabled" : ""}
                  aria-label="${m.name.replace(/"/g, "&quot;")} on ${escapeHtml(i.name)}"
                  onchange="toggleMock('${i.id}','${m.name.replace(/'/g, "\\'")}',this.checked)">
                <span class="slider"></span>
              </label>
              ${fired}
            </div>
          </td>`;
        })
        .join("");

      html += `
        <tr class="mock-row" draggable="true" ondragstart="handleDragStart(event,'${m.file}')">
          <td>
            <div class="mock-meta">
              <h4>${m.name} ${badges}</h4>
              <div class="mock-actions">
                <span class="file-link" onclick="openEditor('${m.file}')">Code: ${pathBasename(m.file)}</span>
                <button class="btn btn-ghost btn-sm scope-btn" title="Which servers this mock applies to" onclick="openScopeEditor('${m.file}','${m.name.replace(/'/g, "\\'")}')">🎯 ${scopeLabel(m)}</button>
                <button class="btn btn-ghost btn-sm" onclick="renameMock('${m.file}')">Rename</button>
                <button class="btn btn-ghost btn-sm" onclick="duplicateMock('${m.file}')">Duplicate</button>
                <button class="btn btn-ghost btn-danger-text btn-sm" onclick="deleteMock('${m.file}')">Delete</button>
              </div>
            </div>
          </td>
          ${instanceCols}
        </tr>`;
    });
  });

  document.getElementById(tbodyId).innerHTML = html;
}

/**
 * Bulk mock toggles, on right-click.
 *
 * Two targets, both only inside the mocks views:
 *  • a **host column header** — every mock shown, for that host;
 *  • a **folder row** — that folder's mocks, for whichever host you pick.
 *
 * Delegated from the container because the table is rebuilt wholesale on every
 * change, so per-element listeners would need re-attaching each time.
 */
export function initMocksMenu() {
  const container = document.getElementById("insp-mocks");
  if (!container) return;

  container.addEventListener("contextmenu", (event) => {
    const data = state.cachedData;
    if (!data) return;

    const head = event.target.closest(".mocks-host-head");
    const folderRow = event.target.closest(".folder-header");
    if (!head && !folderRow) return;

    // Which hosts are in view: one in the per-host mocks view, all of them in
    // "All mocks".
    const inView = state.mocksInstanceId
      ? data.instances.filter((i) => i.id === state.mocksInstanceId)
      : data.instances;

    if (head) {
      const instance = inView.find((i) => i.id === head.dataset.instance);
      if (!instance) return;
      const everyMock = encodeURIComponent(JSON.stringify(data.mocks.map((m) => m.name)));
      return openContextMenu(event, [
        { heading: instance.name || instance.id },
        {
          label: "Turn every mock ON",
          onSelect: () => toggleBulk(instance.id, everyMock, true),
        },
        {
          label: "Turn every mock OFF",
          onSelect: () => toggleBulk(instance.id, everyMock, false),
        },
        { separator: true },
        {
          label: "Reset hit counts",
          hint: "this host",
          onSelect: () => resetMockStats(instance.id),
        },
      ]);
    }

    const { folder, mocks } = folderRow.dataset;
    const items = [{ heading: `📁 ${folder}` }];
    inView.forEach((instance, index) => {
      if (index > 0) items.push({ separator: true });
      items.push(
        { heading: instance.name || instance.id },
        {
          label: "Turn these ON",
          onSelect: () => toggleBulk(instance.id, mocks, true),
        },
        {
          label: "Turn these OFF",
          onSelect: () => toggleBulk(instance.id, mocks, false),
        }
      );
    });
    openContextMenu(event, items);
  });
}

export function handleSearch(value) {
  state.searchTerm = value.toLowerCase();
  renderHostMocks();
}
export function clearMockSearch() {
  state.searchTerm = "";
  const input = document.getElementById("mock-search");
  if (input) input.value = "";
  renderHostMocks();
}

// ── Mock toggles ─────────────────────────────────────────────────

export async function toggleMock(id, name, on) {
  await api("/__admin/toggle", {
    method: "POST",
    body: { instanceId: id, mockName: name, enabled: on },
  });
  window.load?.();
}

export async function toggleBulk(instanceId, encodedNames, enabled) {
  const mockNames = decodeAndParse(encodedNames);
  const res = await api("/__admin/toggle-bulk", {
    method: "POST",
    body: { instanceId, mockNames, enabled },
  });
  if (!res.ok) return toast("Bulk toggle failed", "error");

  // Report what the server actually changed, not what we asked it to. It skips
  // mocks that are out of scope for this host, so counting the request would
  // claim credit for mocks that were never touched.
  const { count } = await res.json().catch(() => ({ count: mockNames.length }));
  const host = state.cachedData?.instances?.find((i) => i.id === instanceId);
  const label = host?.name || instanceId;

  toast(
    count === 0
      ? `No mocks apply to ${label}`
      : `${count} mock${count === 1 ? "" : "s"} turned ${enabled ? "ON" : "OFF"} for ${label}`,
    count === 0 ? "info" : "success"
  );
  window.load?.();
}
