/**
 * `withHeaderCase` — the frontend half of the header-case pair.
 *
 * The backend's `utils/header-case.js` cannot be imported here (`public/js` is
 * native ESM with no build step, the backend is CommonJS), so the rename lives
 * in `util.js` a second time. That makes it exactly the kind of duplicated pure
 * rule that has to be pinned on both sides, or the inspector and the wire drift.
 */
import { withHeaderCase } from "../public/js/modules/util.js";

describe("withHeaderCase", () => {
  test("renames the names it was given a spelling for", () => {
    const out = withHeaderCase(
      { tokenid: "abc", "x-plain": "1" },
      { tokenid: "tokenId" }
    );
    expect(out).toEqual({ tokenId: "abc", "x-plain": "1" });
  });

  test("returns a copy even with no spellings to apply", () => {
    // The replay editor deletes hop-by-hop names out of the result. Handing
    // back the log entry's own map would mutate a record the SSE stream, the
    // capture sessions and the inspector all still hold a reference to.
    const entry = { "content-length": "12", "x-token": "s3cret" };
    const out = withHeaderCase(entry, undefined);
    delete out["content-length"];
    expect(entry["content-length"]).toBe("12");
  });

  test("survives an entry with no headers at all", () => {
    expect(withHeaderCase(undefined, { a: "A" })).toEqual({});
  });
});
