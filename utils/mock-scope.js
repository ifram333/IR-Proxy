/**
 * mock-scope.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewrites the optional `servers` scope field of a single mock inside a
 * `.mock.js` source file, without disturbing the rest of the file.
 *
 * The mock is located by its (unique) `name:` line, so this works for files that
 * export a single object as well as an array of mock objects. A `servers` field
 * is expected to be a single-line array (which is what the dashboard writes);
 * multi-line hand-authored arrays are not matched.
 */

const NAME_LINE = /^\s*name:\s*(['"])(.*?)\1\s*,?\s*$/;
const ANY_NAME_LINE = /^\s*name:\s*['"]/;
const SERVERS_LINE = /^\s*servers:\s*\[[^\]]*\]\s*,?\s*$/;

/** Render a `servers` array as a canonical single-line literal. */
function renderServers(servers) {
  return "[" + servers.map((s) => JSON.stringify(s)).join(", ") + "]";
}

/**
 * Return `source` with the named mock's `servers` field set to `servers`.
 * Passing `null`, `undefined`, or an empty array **removes** the field
 * (i.e. the mock reverts to applying to all servers).
 *
 * @param {string} source   - Full `.mock.js` file contents
 * @param {string} mockName - The mock's `name` value
 * @param {string[]|null} servers - Instance ids, or null/empty to clear scope
 * @returns {string} the rewritten source
 * @throws if the mock name cannot be found
 */
function setMockServers(source, mockName, servers) {
  const lines = source.split("\n");

  // Locate the target mock's `name:` line.
  const nameLineIdx = lines.findIndex((line) => {
    const m = line.match(NAME_LINE);
    return m && m[2] === mockName;
  });
  if (nameLineIdx === -1) {
    throw new Error(`Mock "${mockName}" not found in file`);
  }

  const indent = lines[nameLineIdx].match(/^(\s*)/)[1];

  // Window of this mock's object: up to the next mock's `name:` line (array form).
  let windowEnd = lines.length;
  for (let i = nameLineIdx + 1; i < lines.length; i++) {
    if (ANY_NAME_LINE.test(lines[i])) {
      windowEnd = i;
      break;
    }
  }

  // Existing single-line `servers:` field within this mock's window?
  let serversLineIdx = -1;
  for (let i = nameLineIdx + 1; i < windowEnd; i++) {
    if (SERVERS_LINE.test(lines[i])) {
      serversLineIdx = i;
      break;
    }
  }

  const hasScope = Array.isArray(servers) && servers.length > 0;

  if (hasScope) {
    const canonical = `${indent}servers: ${renderServers(servers)},`;
    if (serversLineIdx !== -1) {
      lines[serversLineIdx] = canonical;
    } else {
      lines.splice(nameLineIdx + 1, 0, canonical);
    }
  } else if (serversLineIdx !== -1) {
    lines.splice(serversLineIdx, 1);
  }

  return lines.join("\n");
}

module.exports = { setMockServers };
