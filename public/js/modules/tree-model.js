/**
 * tree-model.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns the flat list of hosts + log entries into the nested structure the left
 * panel renders: host → path folders → leaf.
 *
 * Deliberately **pure**: no imports, no DOM, no fetch. Every input arrives as an
 * argument and the output is plain data. That makes the two pieces of logic most
 * likely to be quietly wrong — the path grouping and the focus/ignore partition
 * — unit-testable without a browser.
 *
 * The central modelling decision: **a leaf is a path, not a call.** An endpoint
 * polled 200 times shows up once with `hits: 200`; the individual calls live on
 * the leaf and get listed in the inspector's hits table. The old activity-log
 * tree made a sibling leaf per request, which is exactly why it fell apart
 * under load.
 *
 * Each path node also carries whether it is **blocked** — killed on arrival by
 * a rule on its host (`utils/blocking.js`) — and whether it is the node that
 * owns that rule. Two fields rather than one because a child of a blocked
 * folder is just as dead as the folder, and has to say so, but lifting the rule
 * is not its to offer.
 *
 * Its corollary: **one node per path, whether or not anything lives under it.**
 * `/service-status` and `/service-status/123` are an endpoint and its child, not
 * two unrelated things, so the first is a node that both holds its own calls and
 * has children. Building a separate "folder" and "leaf" for that path is what
 * produced two rows with the same id, of which only one could ever be selected —
 * so `kind` is derived at the end from whether a node ended up with children,
 * never decided while walking.
 */

/**
 * Which block rule covers a path, or null. Mirrors `utils/blocking.js` on the
 * server — the rule that actually kills the request. Kept as its own small copy
 * rather than shared, because `public/js` is native ES modules with no build
 * step while the backend is CommonJS; the two are pinned together by
 * `tests/blocking.test.js` and by the cases in `tree-model.test.mjs`.
 */
function blockCovering(path, blocks) {
  if (!Array.isArray(blocks) || !blocks.length || !path) return null;
  const sorted = [...blocks].sort((a, b) => b.length - a.length);
  return (
    sorted.find(
      (rule) => rule === path || (rule !== "/" && path.startsWith(`${rule}/`))
    ) || null
  );
}

/** Section a host belongs to, derived from its `focus` setting. */
export const SECTIONS = ["focus", "none", "ignore"];

export const SECTION_LABELS = {
  focus: "Focused",
  none: "All hosts",
  ignore: "Ignored",
};

/** Strip the query string and split a path into its non-empty segments. */
export function pathSegments(path) {
  const clean = String(path || "").split("?")[0];
  return clean.split("/").filter(Boolean);
}

/**
 * Group hosts into the tree's three sections, preserving the input order
 * (the registry already hands them over most-recently-seen first).
 *
 * @param {object[]} hosts registry records, each with a `focus`
 * @returns {{focus: object[], none: object[], ignore: object[]}}
 */
export function partitionHosts(hosts) {
  const out = { focus: [], none: [], ignore: [] };
  (hosts || []).forEach((host) => {
    const section = SECTIONS.includes(host.focus) ? host.focus : "none";
    out[section].push(host);
  });
  return out;
}

/**
 * Does this host match the filter? Matches on the hostname only — path-level
 * filtering happens per leaf so a matching endpoint keeps its host visible.
 */
function hostMatches(host, query) {
  return !query || host.host.toLowerCase().includes(query);
}

function entryMatches(entry, query) {
  if (!query) return true;
  return (
    String(entry.path || "")
      .toLowerCase()
      .includes(query) ||
    String(entry.method || "")
      .toLowerCase()
      .includes(query) ||
    String(entry.mockName || "")
      .toLowerCase()
      .includes(query) ||
    String(entry.source || "")
      .toLowerCase()
      .includes(query)
  );
}

/**
 * Build the path tree for one host's entries.
 *
 * Nodes are keyed by their accumulated path — **one per path**, so two
 * endpoints under `/v1` share a parent and, more importantly, a path that is
 * both an endpoint and a prefix is a single node. `/service-status` and
 * `/service-status/123` used to produce a "leaf" and a "folder" side by side
 * carrying the *same* id, and since a selection is an id, one of the two could
 * never be opened.
 *
 * So every node is built the same way: it collects the entries that hit that
 * exact path (newest first, reporting the newest one's status/source as its
 * own — that's the row badge) *and* it can grow children. Whether it is a
 * folder or a leaf falls out at the end, in `finalize`.
 *
 * `hits` counts direct calls **plus** everything beneath, which is what the
 * folder counters have always meant; `entries.length` is the direct ones.
 *
 * @param {string} host
 * @param {object[]} entries newest-first log entries for this host
 * @returns {object} the host's root node
 */
function buildHostTree(host, entries, blocks) {
  const root = {
    kind: "host",
    id: `host:${host}`,
    name: host,
    host,
    children: new Map(),
    hits: 0,
    errors: 0,
  };

  // Walk oldest → newest so the "latest wins" fields end up holding the latest.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const segments = pathSegments(entry.path);
    const failed = entry.status >= 400 || entry.status === 0;
    root.hits++;
    if (failed) root.errors++;

    // A request to "/" has no segments; give it a node of its own rather than
    // silently attaching stats to the host and showing nothing to click.
    if (segments.length === 0) segments.push("/");

    let node = root;
    let accumulated = "";

    segments.forEach((segment, index) => {
      accumulated += segment === "/" ? "/" : `/${segment}`;

      let child = node.children.get(accumulated);
      if (!child) {
        child = {
          id: `${host}${accumulated}`,
          name: segment,
          host,
          path: accumulated,
          children: new Map(),
          entries: [],
          hits: 0,
          errors: 0,
          methods: [],
          // Which rule kills this path, and whether this node is the one that
          // owns it. The UI needs both: every covered row wears the BLOCK tag,
          // but only the owner offers to lift it.
          blockedBy: blockCovering(accumulated, blocks),
          blockOwner: blockCovering(accumulated, blocks) === accumulated,
          // Latest *direct* hit, shown on the row itself.
          method: null,
          status: null,
          source: null,
          timestamp: null,
        };
        node.children.set(accumulated, child);
      }

      child.hits++;
      if (failed) child.errors++;

      if (index === segments.length - 1) {
        child.entries.unshift(entry); // keep newest-first for the hits table
        if (entry.method && !child.methods.includes(entry.method)) {
          child.methods.push(entry.method);
        }
        child.method = entry.method;
        child.status = entry.status;
        child.source = entry.source;
        child.timestamp = entry.timestamp;
      }

      node = child;
    });
  }

  return root;
}

/**
 * Turn the child Maps into sorted arrays and settle each node's `kind`.
 *
 * Folders before leaves, then alphabetically — stable across re-renders. `kind`
 * is decided **here**, from whether anything ended up underneath, which is the
 * only point at which that is actually known: a path can be hit directly long
 * before the request that gives it a child arrives.
 */
function finalize(node) {
  const children = [...node.children.values()].map(finalize);
  children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children = children;
  if (node.kind !== "host") node.kind = children.length ? "folder" : "leaf";
  return node;
}

/**
 * Build the whole left-panel model.
 *
 * @param {object} input
 * @param {object[]} input.hosts   registry records
 * @param {object[]} input.entries log entries, newest first
 * @param {string}  [input.query]  filter text
 * @returns {{sections: Array<{key,label,hosts}>, total: number, matched: number}}
 */
export function buildTree({ hosts = [], entries = [], query = "" } = {}) {
  const q = String(query || "")
    .trim()
    .toLowerCase();

  // Bucket every entry by host once, rather than scanning the log per host.
  // Filtering happens per host below, not here: a query that matches a HOSTNAME
  // has to keep that host's requests, otherwise searching for a host shows the
  // row with an empty subtree, which reads as "this host has no traffic".
  const byHost = new Map();
  entries.forEach((entry) => {
    if (!entry || !entry.host) return;
    if (!byHost.has(entry.host)) byHost.set(entry.host, []);
    byHost.get(entry.host).push(entry);
  });

  // A host with traffic but no registry record still belongs in the tree —
  // otherwise a restart of the registry would make live rows disappear.
  const known = new Set(hosts.map((h) => h.host));
  const allHosts = [...hosts];
  byHost.forEach((_entries, host) => {
    if (!known.has(host)) {
      allHosts.push({
        host,
        ssl: false,
        focus: "none",
        instanceId: null,
        synthetic: true,
      });
    }
  });

  const partitioned = partitionHosts(allHosts);
  let matched = 0;

  const sections = SECTIONS.map((key) => {
    const sectionHosts = partitioned[key]
      .map((host) => {
        const all = byHost.get(host.host) || [];

        // Matching the hostname shows everything under it; otherwise narrow to
        // the requests that matched. Either way the host stays visible only if
        // something about it matched.
        const hostHit = hostMatches(host, q);
        const hostEntries = !q || hostHit ? all : all.filter((e) => entryMatches(e, q));
        if (q && !hostHit && hostEntries.length === 0) return null;

        const tree = finalize(buildHostTree(host.host, hostEntries, host.blocks));
        matched += tree.hits;
        return { ...host, ...tree };
      })
      .filter(Boolean);

    // Alphabetical, never by recency. The registry hands hosts over
    // most-recently-seen first, but this tree re-renders on every batch of
    // live traffic — recency ordering makes rows jump under the pointer, so
    // you can't reliably click the host you're aiming at.
    sectionHosts.sort((a, b) => a.host.localeCompare(b.host));

    return { key, label: SECTION_LABELS[key], hosts: sectionHosts };
  });

  return { sections, total: entries.length, matched };
}

/**
 * Walk a built tree and return the node with this id, or null.
 * Used to re-resolve the selection after a re-render.
 */
export function findNode(model, id) {
  if (!id) return null;
  const visit = (node) => {
    if (node.id === id) return node;
    if (!Array.isArray(node.children)) return null;
    for (const child of node.children) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const section of model.sections) {
    for (const host of section.hosts) {
      const hit = visit(host);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Every call under a node, for the inspector's hits table. Selecting a folder
 * shows everything beneath it, which is how you inspect a whole API surface.
 *
 * Every node is asked for its own entries, not just the leaves: a folder can be
 * an endpoint in its own right, and skipping its calls would hide the exact ones
 * that made it a folder-and-leaf in the first place.
 */
export function collectEntries(node) {
  if (!node) return [];
  if (node.kind === "leaf") return [...node.entries]; // already newest-first
  const out = [];
  const visit = (n) => {
    if (Array.isArray(n.entries)) out.push(...n.entries);
    (Array.isArray(n.children) ? n.children : []).forEach(visit);
  };
  visit(node);
  // Newest first, matching how the log itself is ordered.
  return out.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}
