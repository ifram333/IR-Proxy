/**
 * panel-search — the pure core of find-in-panel.
 *
 * `.mjs` because it imports the dashboard's ES modules directly (see CLAUDE.md).
 * These two functions were unreachable by any test while they lived inside
 * inspector.js: one is where a half-typed regex has to fail gracefully, the
 * other is where a zero-width match used to hang the tab.
 */
import { searchPattern, markMatches } from "../public/js/modules/panel-search.js";

/** Collect every `<mark>`ed substring out of the returned HTML. */
const marked = (html) =>
  html === null
    ? null
    : [...html.matchAll(/<mark class="jt-hit">(.*?)<\/mark>/g)].map((m) => m[1]);

describe("searchPattern", () => {
  test("plain text is matched literally, not as a pattern", () => {
    const { re } = searchPattern("a.c");
    expect(re.test("abc")).toBe(false);
    re.lastIndex = 0;
    expect(re.test("a.c")).toBe(true);
  });

  test("regex metacharacters are all escaped in plain mode", () => {
    // Every character the escape list covers, in one query.
    const query = ".*+?^${}()|[]\\";
    const { re, error } = searchPattern(query);
    expect(error).toBeUndefined();
    re.lastIndex = 0;
    expect(re.test(query)).toBe(true);
  });

  test("regex mode compiles the query as written", () => {
    const { re } = searchPattern("a.c", true);
    expect(re.test("abc")).toBe(true);
  });

  test("matching is case-insensitive in both modes", () => {
    expect(searchPattern("TOKEN").re.test("token")).toBe(true);
    expect(searchPattern("tok.n", true).re.test("TOKEN")).toBe(true);
  });

  test("the pattern is global, so a highlighter can walk every hit", () => {
    expect(searchPattern("a").re.global).toBe(true);
  });

  test("a half-typed regex returns the reason instead of throwing", () => {
    // `(` and `[a-` are what the box holds most of the time while you type.
    for (const bad of ["(", "[a-", "*", "a{2,1}"]) {
      const result = searchPattern(bad, true);
      expect(result.re).toBeUndefined();
      expect(typeof result.error).toBe("string");
    }
  });

  test("the same broken input is harmless in plain mode", () => {
    expect(searchPattern("(", false).error).toBeUndefined();
  });
});

describe("markMatches", () => {
  test("returns null when nothing matched, so the node is left alone", () => {
    expect(markMatches("hello", searchPattern("zzz").re)).toBeNull();
  });

  test("marks every occurrence", () => {
    const html = markMatches("a b a b a", searchPattern("a").re);
    expect(marked(html)).toEqual(["a", "a", "a"]);
  });

  test("keeps the text around the hits", () => {
    expect(markMatches("xxTOKENyy", searchPattern("token").re)).toBe(
      'xx<mark class="jt-hit">TOKEN</mark>yy'
    );
  });

  test("a zero-width match steps forward instead of hanging", () => {
    // The bug this guard exists for: `a*` matches empty at every position and
    // never advances lastIndex, so the loop spun forever and froze the tab.
    const html = markMatches("bab", searchPattern("a*", true).re);
    expect(marked(html)).toEqual(["a"]);
  });

  test("a pattern that ONLY matches empty produces no marks at all", () => {
    for (const pattern of ["^", "\\b", "x*"]) {
      expect(markMatches("bcd", searchPattern(pattern, true).re)).toBeNull();
    }
  });

  test("HTML in the searched text is escaped, matched or not", () => {
    // The text comes from a captured response body, so it is exactly the place
    // markup must not survive into innerHTML.
    const html = markMatches("<img src=x onerror=alert(1)> hi", searchPattern("img").re);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;");
    expect(marked(html)).toEqual(["img"]);
  });

  test("a match that is itself markup is escaped inside the mark", () => {
    const html = markMatches("a <b> c", searchPattern("<b>").re);
    expect(html).toBe('a <mark class="jt-hit">&lt;b&gt;</mark> c');
  });

  test("adjacent matches do not swallow the text between them", () => {
    expect(markMatches("aa", searchPattern("a").re)).toBe(
      '<mark class="jt-hit">a</mark><mark class="jt-hit">a</mark>'
    );
  });

  test("a regex is reusable across runs — lastIndex is reset", () => {
    const { re } = searchPattern("a");
    expect(marked(markMatches("a a", re))).toEqual(["a", "a"]);
    expect(marked(markMatches("a a", re))).toEqual(["a", "a"]);
  });
});
