/**
 * Mock files on disk: read, write, create, rename, duplicate, delete, rescope.
 *
 * Every path here goes through `safePath`, which is the only thing standing between
 * a caller-supplied filename and an arbitrary write.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const loadMocks = require("../mock-loader");
const { setMockServers } = require("../mock-scope");

module.exports = function registerMocks(router, ctx) {
  const { MOCKS_DIR, serverConfigs, safePath, knownInstance } = ctx;

  // ── Mock file CRUD ─────────────────────────────────────────────────────────
  router.get("/mock-content", (req, res) => {
    try {
      const filePath = safePath(req.query.file);
      if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
      res.json({ content: fs.readFileSync(filePath, "utf8") });
    } catch (err) {
      res.status(400).send(err.message);
    }
  });

  router.post("/save-mock", (req, res) => {
    const { file, content } = req.body;
    try {
      const filePath = safePath(file);
      if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
      fs.writeFileSync(filePath, content, "utf8");
      loadMocks.invalidate();
      console.log(`💾 [ADMIN] Saved mock: ${file}`);
      res.sendStatus(200);
    } catch (err) {
      res.status(400).send(err.message);
    }
  });

  router.post("/create-mock", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).send("Name is required");
    try {
      const fileName = name.endsWith(".mock.js") ? name : `${name}.mock.js`;
      const filePath = safePath(fileName);
      const fileDir = path.dirname(filePath);
      if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
      if (fs.existsSync(filePath)) return res.status(400).send("File already exists");
      const baseName = path.basename(fileName, ".mock.js");
      const template = `module.exports = {\n  name: "${baseName}",\n  match: (req) => req.path === '/api/example' && req.method === 'GET',\n  respond: (req, res) => {\n    res.status(200).json({ message: "New mock created successfully!" });\n  }\n};\n`;
      fs.writeFileSync(filePath, template, "utf8");
      loadMocks.invalidate();
      console.log(`✨ [ADMIN] Created mock: ${fileName}`);
      res.sendStatus(201);
    } catch (err) {
      res.status(err.message.includes("traversal") ? 400 : 500).send(err.message);
    }
  });

  router.post("/delete-mock", (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).send("File path is required");
    try {
      const filePath = safePath(file);
      if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
      fs.unlinkSync(filePath);
      loadMocks.invalidate();
      console.log(`🗑️  [ADMIN] Deleted mock: ${file}`);
      res.sendStatus(200);
    } catch (err) {
      res.status(err.message.includes("traversal") ? 400 : 500).send(err.message);
    }
  });

  router.post("/rename-mock", (req, res) => {
    const { oldName, newName } = req.body;
    try {
      const cleanOld = oldName.replace(/\\/g, "/");
      const cleanNew = (
        newName.endsWith(".mock.js") ? newName : `${newName}.mock.js`
      ).replace(/\\/g, "/");
      const oldPath = safePath(cleanOld);
      const newPath = safePath(cleanNew);
      if (!fs.existsSync(oldPath)) return res.status(404).send("Source not found");
      const newDir = path.dirname(newPath);
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
      loadMocks.invalidate();
      console.log(`✏️  [ADMIN] Renamed: ${cleanOld} → ${cleanNew}`);
      res.sendStatus(200);
    } catch (err) {
      res.status(err.message.includes("traversal") ? 400 : 500).send(err.message);
    }
  });

  router.post("/duplicate-mock", (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).send("File path is required");
    try {
      const srcPath = safePath(file);
      if (!fs.existsSync(srcPath)) return res.status(404).send("File not found");
      const base = file.replace(/\.mock\.js$/, "");
      let destFile = `${base}-copy.mock.js`;
      let destPath = safePath(destFile);
      let n = 2;
      while (fs.existsSync(destPath)) {
        destFile = `${base}-copy${n}.mock.js`;
        destPath = safePath(destFile);
        n++;
      }
      fs.copyFileSync(srcPath, destPath);
      loadMocks.invalidate();
      console.log(`📋 [ADMIN] Duplicated: ${file} → ${destFile}`);
      res.json({ newFile: destFile });
    } catch (err) {
      res.status(err.message.includes("traversal") ? 400 : 500).send(err.message);
    }
  });

  // Set a mock's server scope by rewriting its file's `servers` field.
  // `servers`: array of instance ids, or null/empty/all-selected → clear scope.
  router.post("/mock-scope", (req, res) => {
    const { file, name, servers } = req.body;
    if (!file || !name) {
      return res.status(400).json({ error: "Required fields: file, name" });
    }
    // Keep only known instance ids; full selection (or none) means "all servers".
    let scope = null;
    if (Array.isArray(servers) && servers.length) {
      const valid = servers.filter((id) => knownInstance(id));
      if (valid.length && valid.length < serverConfigs.length) scope = valid;
    }
    try {
      const filePath = safePath(file);
      if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
      const source = fs.readFileSync(filePath, "utf8");
      const updated = setMockServers(source, name, scope);
      fs.writeFileSync(filePath, updated, "utf8");
      loadMocks.invalidate();
      console.log(
        `🎯 [ADMIN] Scoped "${name}" → ${scope ? scope.join(", ") : "all servers"}`
      );
      res.json({ ok: true, name, servers: scope });
    } catch (err) {
      const status = err.message.includes("traversal")
        ? 400
        : err.message.includes("not found")
          ? 404
          : 500;
      res.status(status).send(err.message);
    }
  });

  // ── Simplified endpoints for external/CI consumers ────────────────────────
  router.get("/mocks", (_req, res) => {
    const mockRegistry = loadMocks(MOCKS_DIR);
    res.json({
      mocks: mockRegistry.map((m) => ({
        name: m.name,
        file: m.file,
        folder: m.folder || null,
        delay: m.delay || 0,
        servers: m.servers || null,
      })),
    });
  });
};
