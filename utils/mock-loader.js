const fs = require("fs");
const path = require("path");

let _cache = null;
let _cacheValid = false;
let _watcherDir = null;
let _watcher = null;

/** Start a filesystem watcher to auto-invalidate the cache when mock files change. */
function _startWatcher(directory) {
  if (_watcherDir === directory && _watcher) return;
  if (_watcher) {
    try {
      _watcher.close();
    } catch (_) {}
  }
  _watcherDir = directory;
  try {
    _watcher = fs.watch(directory, { recursive: true }, (event, filename) => {
      if (filename?.endsWith(".mock.js")) {
        _cacheValid = false;
      }
    });
    // Don't let the watcher keep short-lived processes (e.g. tests) alive.
    _watcher.unref?.();
    _watcher.on("error", () => {
      _watcher = null;
      _watcherDir = null;
    });
  } catch (e) {
    console.warn("⚠️  Mock watcher could not start:", e.message);
  }
}

/** Recursively load all .mock.js files from disk. */
function _loadFromDisk(directory, rootDir = directory) {
  let mocks = [];
  if (!fs.existsSync(directory)) return [];

  const files = fs.readdirSync(directory);

  for (const file of files) {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      mocks = [...mocks, ..._loadFromDisk(fullPath, rootDir)];
    } else if (file.endsWith(".mock.js")) {
      try {
        const relativeSystemPath = path.relative(rootDir, fullPath);
        const folderName = path.dirname(relativeSystemPath);
        const webRelativePath = relativeSystemPath.split(path.sep).join("/");
        const webFolderName = folderName.split(path.sep).join("/");

        // Hot-reload: clear require cache for this file
        const resolvedPath = require.resolve(fullPath);
        if (require.cache[resolvedPath]) delete require.cache[resolvedPath];

        const fileMocks = require(fullPath);
        const normalizedMocks = Array.isArray(fileMocks) ? fileMocks : [fileMocks];

        normalizedMocks.forEach((m, index) => {
          m.file = webRelativePath;
          m.folder =
            webFolderName === "." || webFolderName === "" ? "Root" : webFolderName;
          if (!m.name) {
            m.name = `${file.replace(".mock.js", "")} #${index + 1}`;
          }
          // Normalize the optional server scope: a non-empty array restricts the
          // mock to those instance ids; anything else means "all servers".
          m.servers = Array.isArray(m.servers) && m.servers.length ? m.servers : null;
        });

        mocks = [...mocks, ...normalizedMocks];
      } catch (err) {
        console.error(`❌ Error loading mock file [${file}]:`, err.message);
      }
    }
  }
  return mocks;
}

/**
 * Load mocks with an in-memory cache. The cache is automatically invalidated
 * when any .mock.js file in the directory changes (via fs.watch).
 * @param {string} directory - Root mocks directory
 * @returns {Array} Array of mock objects
 */
function loadMocks(directory) {
  if (!_cacheValid || !_cache) {
    _cache = _loadFromDisk(directory);
    _cacheValid = true;
    _startWatcher(directory);
  }
  return _cache;
}

/** Force the next call to loadMocks() to reload from disk. */
loadMocks.invalidate = function () {
  _cacheValid = false;
};

module.exports = loadMocks;
