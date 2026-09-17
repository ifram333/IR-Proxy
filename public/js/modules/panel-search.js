/**
 * panel-search.js — find-in-panel over a rendered JSON tree.
 *
 * Pulled out of inspector.js, which had grown a whole text-search engine in its
 * middle: compiling the query, marking hits, counting them, stepping between
 * them, and remembering the regex toggle. None of that needs to know what an
 * inspector is — only which subtree is on screen.
 *
 * So the host panel supplies that, once, through `configureSearch`:
 *
 *   • `section()`   — the subtree to search. Deliberately **one** section, not
 *     the whole panel: a hit count spanning four tabs you can't see is a count
 *     of nothing you asked about, and stepping through it drags you between
 *     tabs.
 *   • `container()` — where stale `<mark>`s may linger. Wider than `section()`
 *     on purpose, because switching tabs leaves highlights behind in the one you
 *     left.
 *
 * Two functions here are **pure and tested** (`tests/panel-search.test.mjs`):
 * `searchPattern`, which is where a half-typed regex has to fail gracefully,
 * and `markMatches`, which is where a zero-width match used to hang the tab.
 * They were unreachable by tests while they lived inside a DOM-driven module.
 *
 * The `insp-*` element ids are the search widget's own; they read as inspector
 * ids because that is the only panel that hosts one today.
 */
import { escapeHtml, debounce } from "./util.js";
import { expandAncestors } from "./jsontree.js";

const SEARCH_KEY = "ir-proxy.search";

let _searchState = null; // { matches: HTMLElement[], index, invalid? }
let _searchRegex = false;

let _section = () => null;
let _container = () => null;

const el = (id) => document.getElementById(id);

/**
 * Tell the search which DOM it works over.
 *
 * @param {object} opts
 * @param {Function} opts.section   returns the element to search, or null
 * @param {Function} opts.container returns the element to clear highlights from
 */
export function configureSearch({ section, container }) {
  if (section) _section = section;
  if (container) _container = container;
}

// ── Pure core ────────────────────────────────────────────────────

/**
 * Compile the query into the RegExp the highlighter runs.
 *
 * Plain text is escaped into that same RegExp rather than kept on a separate
 * `indexOf` path, so there is one way matches are found and one place they can
 * go wrong.
 *
 * Case-insensitive in both modes: it's what the search has always done, and a
 * regex that wants case can say so with `(?-i)`-style constructs… which JS
 * doesn't have, so an explicit toggle is the follow-up if you ever need it.
 *
 * @param {string} query
 * @param {boolean} [asRegex] treat the query as a pattern rather than literal text
 * @returns {{re: RegExp}|{error: string}}
 */
export function searchPattern(query, asRegex = false) {
  const source = asRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return { re: new RegExp(source, "gi") };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Mark every match in a run of text.
 *
 * @param {string} text plain text, exactly as it will be displayed
 * @param {RegExp} re   a global regex from `searchPattern`
 * @returns {string|null} escaped HTML with `<mark class="jt-hit">` around each
 *   hit, or null when nothing matched — the caller then leaves the node alone
 *   rather than rewriting it to identical markup.
 */
export function markMatches(text, re) {
  re.lastIndex = 0;
  let html = "";
  let i = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    // A pattern that can match nothing — `a*`, `^`, `\b` — never advances
    // lastIndex on its own, so without this the tab hangs on the first empty
    // match. Step over it instead of marking a zero-width range.
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    html += escapeHtml(text.slice(i, m.index));
    html += `<mark class="jt-hit">${escapeHtml(m[0])}</mark>`;
    i = m.index + m[0].length;
  }
  if (i === 0) return null; // nothing matched in this run
  return html + escapeHtml(text.slice(i));
}

// ── DOM ──────────────────────────────────────────────────────────

export function clearHighlights() {
  _container()
    ?.querySelectorAll("mark.jt-hit")
    .forEach((mark) => {
      mark.replaceWith(document.createTextNode(mark.textContent));
      mark.parentNode?.normalize?.();
    });
}

function applyHighlights(re) {
  const root = _section();
  if (!root) return [];
  const matches = [];
  root.querySelectorAll(".jt-leaf-text").forEach((leaf) => {
    const html = markMatches(leaf.textContent, re);
    if (html === null) return;
    leaf.innerHTML = html;
    leaf.querySelectorAll("mark.jt-hit").forEach((mark) => matches.push(mark));
  });
  return matches;
}

export function resetSearch() {
  const input = el("insp-search");
  if (input) input.value = "";
  clearHighlights();
  _searchState = null;
  markSearchInvalid(null);
  updateSearchCounter();
}

/** Restore the regex toggle. Never throws — a corrupt value just means off. */
export function loadSearchPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_KEY) || "{}");
    _searchRegex = saved.regex === true;
  } catch {
    _searchRegex = false;
  }
  syncRegexButton();
}

/**
 * Re-run an active search after the visible section changes, so the highlights
 * and the n/m counter always describe what's on screen. Nothing happens when the
 * box is empty — that keeps the counter blank instead of showing "0/0".
 */
export function rescopeSearch() {
  const query = el("insp-search")?.value;
  if (query?.trim()) runSearch(query);
}

function runSearch(query) {
  clearHighlights();
  // Only trim in plain mode. A regex is allowed to care about spaces, and
  // silently eating the ones the user typed would make ` +$` unusable.
  const needle = _searchRegex ? query : query.trim();
  if (!query.trim()) {
    // An empty box is "not searching", not "searching for nothing" — leaving
    // state behind is what made the counter read 0/0 after you cleared it.
    _searchState = null;
    markSearchInvalid(null);
    updateSearchCounter();
    return;
  }

  const compiled = searchPattern(needle, _searchRegex);
  markSearchInvalid(compiled.error || null);
  if (compiled.error) {
    // Half-typed patterns are invalid most of the time — `(`, `[a-`. Say so in
    // the box and leave the previous highlights cleared rather than throwing.
    _searchState = { matches: [], index: -1, invalid: true };
    updateSearchCounter();
    return;
  }

  const matches = applyHighlights(compiled.re);
  _searchState = { matches, index: matches.length ? 0 : -1 };
  updateSearchCounter();
  if (matches.length) goToMatch(0);
}
export const handleInspectorSearch = debounce(runSearch, 120);

/** Flag a bad pattern on the input itself; the counter has no room for a reason. */
function markSearchInvalid(message) {
  const input = el("insp-search");
  if (!input) return;
  input.classList.toggle("invalid", Boolean(message));
  // No prefix of our own: the engine's message already opens with "Invalid
  // regular expression:".
  if (message) input.title = message;
  else input.removeAttribute("title");
}

/** Turn regex matching on or off, and re-run whatever is in the box. */
export function toggleInspectorRegex() {
  _searchRegex = !_searchRegex;
  syncRegexButton();
  try {
    localStorage.setItem(SEARCH_KEY, JSON.stringify({ regex: _searchRegex }));
  } catch {
    // Private mode or full storage: the toggle worked, it just won't stick.
  }
  runSearch(el("insp-search")?.value || "");
  el("insp-search")?.focus();
}

function syncRegexButton() {
  const btn = el("insp-search-regex");
  if (!btn) return;
  btn.classList.toggle("active", _searchRegex);
  btn.setAttribute("aria-pressed", String(_searchRegex));
}

function updateSearchCounter() {
  const node = el("insp-search-count");
  if (!node) return;
  node.textContent = _searchState?.invalid
    ? "⚠"
    : _searchState?.matches.length
      ? `${_searchState.index + 1}/${_searchState.matches.length}`
      : _searchState
        ? "0/0"
        : "";
}

function goToMatch(i) {
  if (!_searchState?.matches.length) return;
  _searchState.matches[_searchState.index]?.classList.remove("jt-hit-current");
  _searchState.index = i;
  const mark = _searchState.matches[i];
  mark.classList.add("jt-hit-current");
  // Every match is in the visible section by construction, so the only thing
  // that can still be hiding one is a collapsed JSON node.
  expandAncestors(mark);
  mark.scrollIntoView({ block: "center", behavior: "smooth" });
  updateSearchCounter();
}

export function inspectorSearchNext() {
  if (_searchState?.matches.length) {
    goToMatch((_searchState.index + 1) % _searchState.matches.length);
  }
}
export function inspectorSearchPrev() {
  if (_searchState?.matches.length) {
    goToMatch(
      (_searchState.index - 1 + _searchState.matches.length) % _searchState.matches.length
    );
  }
}
export function handleInspectorSearchKey(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) inspectorSearchPrev();
    else inspectorSearchNext();
  } else if (event.key === "Escape" && event.target.value) {
    event.target.value = "";
    event.stopPropagation();
    runSearch("");
  }
}
