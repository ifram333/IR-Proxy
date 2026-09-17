/**
 * Shared dashboard state + constants.
 *
 * `state` holds the mutable values that several modules read and write. It is a
 * single exported object (not individual `let`s) because ES module bindings are
 * read-only across modules — mutating `state.foo` works everywhere it's imported.
 */
export const state = {
  currentFile: null, // path of the mock currently open in the editor
  aceEditor: null, // Ace editor instance
  editorBaseline: "", // editor contents when last opened/saved (dirty check)
  cachedData: null, // last /__admin/config response
  searchTerm: "", // mock-table filter
  activityLogVisible: true,
  confirmResolve: null, // pending confirm-modal resolver
  promptResolve: null, // pending prompt-modal resolver
  activeTab: "all", // "all" | serverId
  proxyStatus: null, // cached /__admin/proxy/status response
  logPaused: false, // server-side recording switch, from /__admin/health
  mockStats: {}, // { [instanceId]: { [mockName]: { count, lastAt } } }
  allLogs: [], // activity-log entries (newest first)

  // ── Workspace (host tree + inspector) ──────────────────────────
  hosts: [], // /__admin/hosts records, most recently seen first
  treeQuery: "", // left-panel filter
  selectedNodeId: null, // id of the selected tree node (host/folder/leaf)
  selectedEntryId: null, // id of the row picked in the hits table
  collapsedNodes: new Set(), // tree node ids the user collapsed
  collapsedSections: new Set(), // tree sections ("focus"|"none"|"ignore") collapsed
  inspectorMode: "traffic", // "traffic" | "mocks" | "requests" — what the right pane shows

  logMode: "list", // "list" | "tree"
  mocksCollapsed: false, // mocks panel collapsed to widen the activity log
  collapsedPaths: new Set(),
  logSearchQuery: "",
  selectedLogEntry: null, // entry shown in the detail modal
  logDetailRaw: {}, // { "req-headers"|"req-body"|"res-headers"|"res-body"|"req-query": string|null } — exact copy-paste text per detail-modal section
  scopeEditTarget: null, // { file, name } being edited in the scope modal
};

// Polling cadence (ms). The config/state view is refreshed on demand (after each
// dashboard action), so only the lightweight health badge polls in the
// background.
export const HEALTH_INTERVAL_MS = 30000; // proxy health refresh

// Maps a request's `source` to its short uppercase badge label.
export const SRC_LABEL_MAP = {
  mock: "MOCK",
  proxy: "PROXY",
  intercept: "INTERCEPT",
  "server-off": "OFF",
  blocked: "BLOCK",
};
export const srcLabelFor = (src) =>
  SRC_LABEL_MAP[src] || String(src || "proxy").toUpperCase();
