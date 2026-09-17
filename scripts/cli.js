#!/usr/bin/env node
/**
 * Mock Proxy CLI
 * Usage: node scripts/cli.js <command> [options]
 *
 * Commands:
 *   toggle   --instance <id> --mock "<name>" --on | --off
 *   bulk     --instance <id> --folder "<folder>" --on | --off
 *   list     [--search <term>]
 *   status
 *   health
 *   latency  --instance <id> [--ms <n>]
 *   block    --host <hostname> --path </path>
 *   unblock  --host <hostname> --path </path>
 *   blocks   [--host <hostname>] [--path </path>]
 *   run      --collection <id> | --request <id> | --all
 *   checks   [--search <term>]
 *   profiles
 *   profile:save   --name "<name>"
 *   profile:load   --name "<name>"
 *   profile:delete --name "<name>"
 */

"use strict";
const http = require("http");
const fs = require("fs");

// ── ANSI colours (no deps) ────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};
const ok = (s) => `${c.green}✅ ${s}${c.reset}`;
const err = (s) => `${c.red}❌ ${s}${c.reset}`;
const info = (s) => `${c.cyan}ℹ️  ${s}${c.reset}`;
const warn = (s) => `${c.yellow}⚠️  ${s}${c.reset}`;
const bold = (s) => `${c.bold}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;

// ── Arg parser ────────────────────────────────────────────────────────────────
/**
 * Flags that may be given more than once, collected into an array.
 *
 * An allowlist rather than making every key an array: last-one-wins is right
 * for `--instance` and every other flag here, and changing that globally would
 * quietly alter all of them to fix one.
 */
const REPEATABLE = new Set(["var"]);

function parseArgs(argv) {
  const params = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      let value = true;
      if (next && !next.startsWith("--")) {
        value = next;
        i++;
      }
      if (REPEATABLE.has(key)) {
        (params[key] ||= []).push(value);
      } else {
        params[key] = value;
      }
    }
  }
  return params;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
// The proxy/dashboard listens on config.proxy.preferredPort (8888 by default),
// falling back to the next free port. Rather than hardcode it, the CLI scans
// that same range and auto-detects the live server. MOCK_PORT overrides this.
let _proxyCfg = { preferredPort: 8888 };
try {
  _proxyCfg = require("../config").proxy || _proxyCfg;
} catch (_) {
  /* config not found — fall back to defaults */
}
const PREFERRED_PORT = _proxyCfg.preferredPort || 8888;
const PORT_SCAN = 20; // matches proxy-server.js MAX_PORT_SCAN
const HOST = process.env.MOCK_HOST || "localhost";

let _resolvedPort = null;

/** Probe a port for OUR admin server (so another proxy on 8888 isn't matched). */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: HOST, port, path: "/__admin/health", method: "GET", timeout: 500 },
      (res) => {
        let data = "";
        res.on("data", (ch) => (data += ch));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            resolve(!!j && j.status === "ok" && Array.isArray(j.instances));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Resolve the admin port once: MOCK_PORT wins, else auto-detect via scan. */
async function resolvePort() {
  if (_resolvedPort) return _resolvedPort;
  const explicit = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : null;
  if (explicit) return (_resolvedPort = explicit);
  for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + PORT_SCAN; p++) {
    if (await probe(p)) return (_resolvedPort = p);
  }
  // Nothing answered — fall back so request() surfaces a clear connection error.
  return (_resolvedPort = PREFERRED_PORT);
}

/** Human-friendly host:port label for messages (port may not be resolved yet). */
function serverLabel() {
  return `${HOST}:${_resolvedPort || `${PREFERRED_PORT}…${PREFERRED_PORT + PORT_SCAN}`}`;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    resolvePort()
      .then((port) => {
        const payload = body ? JSON.stringify(body) : null;
        const opts = {
          hostname: HOST,
          port,
          path: `/__admin${path}`,
          method,
          headers: { "Content-Type": "application/json" },
        };
        if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);

        const req = http.request(opts, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              data = JSON.parse(data);
            } catch (_) {
              /* leave as string */
            }
            resolve({ status: res.statusCode, body: data });
          });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      })
      .catch(reject);
  });
}

const GET = (path) => request("GET", path);
const POST = (path, body) => request("POST", path, body);

// ── Help ──────────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
${bold("IR Proxy CLI")}  ${dim(`(server: ${serverLabel()})`)}

${bold("Usage:")}
  npm run mock -- <command> [options]

${bold("Commands:")}
  ${c.cyan}toggle${c.reset}          Toggle a single mock on/off
    ${dim("--instance <id>   Instance ID (e.g. api, auth)")}
    ${dim('--mock "<name>"   Mock name')}
    ${dim("--on | --off      Enable or disable")}

  ${c.cyan}bulk${c.reset}            Toggle all mocks in a folder on/off
    ${dim("--instance <id>")}
    ${dim('--folder "<name>" Folder name (or "Root")')}
    ${dim("--on | --off")}

  ${c.cyan}list${c.reset}            List all mocks with their current status
    ${dim("--search <term>   Filter by name (optional)")}
    ${dim("--instance <id>   Show state for a specific instance (optional)")}

  ${c.cyan}status${c.reset}          Show current toggle states for all instances

  ${c.cyan}health${c.reset}          Show server health (uptime, mock count, instances)

  ${c.cyan}standalone${c.reset}      Start/stop the direct :3000/:3001/:3002 servers
    ${dim("--on | --off      Enable or disable (omit to show current state)")}

  ${c.cyan}latency${c.reset}         Simulate network latency on an instance (mocks + proxied)
    ${dim("--instance <id>   Instance ID (e.g. api, auth)")}
    ${dim("--ms <n>          Added ms per response; 0 disables (omit to show current)")}

  ${c.cyan}block${c.reset}           Kill every call to a path — the connection dies, unanswered
    ${dim("--host <hostname> Host as it appears in the tree (e.g. api.example.com)")}
    ${dim('--path </path>    Path prefix: "/orders" also kills /orders/42')}

  ${c.cyan}unblock${c.reset}         Lift exactly this rule (a path blocked by a parent stays blocked)
    ${dim("--host <hostname>")}
    ${dim("--path </path>")}

  ${c.cyan}blocks${c.reset}          Show what is blocked
    ${dim("--host <hostname> One host's rules (optional)")}
    ${dim("--path </path>    Ask whether one path would die (needs --host)")}

  ${c.cyan}run${c.reset}             Send saved requests and check their responses
    ${dim("--collection <id> Run a whole collection, in order")}
    ${dim("--request <id>    Run one")}
    ${dim("--all             Run every saved request")}
    ${dim("--schema-file <f> Check against this JSON Schema instead of the stored one")}
    ${dim("--status <n>      Expect this status instead of the stored one")}
    ${dim("--no-check        Send without checking anything")}
    ${dim("--var name=value  Set a {{ variable }}; repeatable, applies to every request")}
    ${dim("Exits non-zero when anything failed \u2014 which is the point in CI.")}

  ${c.cyan}checks${c.reset}          Show which saved requests check their response

  ${c.cyan}profiles${c.reset}        List all saved scenario profiles

  ${c.cyan}profile:save${c.reset}    Save current mock state as a named profile
    ${dim('--name "<name>"')}

  ${c.cyan}profile:load${c.reset}    Load a saved profile (replaces all current states)
    ${dim('--name "<name>"')}

  ${c.cyan}profile:delete${c.reset}  Delete a saved profile
    ${dim('--name "<name>"')}

${bold("Options:")}
  ${dim("--help            Show this help")}

${bold("Env vars:")}
  ${dim(`MOCK_PORT         Admin port override (default: auto-detect ${PREFERRED_PORT}…${PREFERRED_PORT + PORT_SCAN})`)}
  ${dim("MOCK_HOST         Admin server host (default: localhost)")}

${bold("Examples:")}
  ${dim(`npm run mock -- toggle --instance api --mock "Account Locked" --on`)}
  ${dim(`npm run mock -- bulk --instance auth --folder "offers" --off`)}
  ${dim(`npm run mock -- list --search "vehicle"`)}
  ${dim(`npm run mock -- standalone --on`)}
  ${dim(`npm run mock -- latency --instance api --ms 1500`)}
  ${dim(`npm run mock -- block --host api.example.com --path /orders`)}
  ${dim(`npm run mock -- blocks --host api.example.com --path /orders/42`)}
  ${dim(`npm run mock -- unblock --host api.example.com --path /orders`)}
  ${dim(`npm run mock -- run --collection checkout-flow`)}
  ${dim(`npm run mock -- run --request get-order --schema-file ./schemas/order.schema.json`)}
  ${dim(`npm run mock -- run --collection checkout-flow --var token=$QA_TOKEN --var id=42`)}
  ${dim(`npm run mock -- checks --search order`)}
  ${dim(`npm run mock -- profile:save --name "happy-path"`)}
  ${dim(`npm run mock -- profile:load --name "error-state"`)}
`);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdToggle(params) {
  const instanceId = params.instance;
  const mockName = params.mock;
  // Fix: --off sets params.off = true, --on sets params.on = true
  const enabled = "on" in params ? true : "off" in params ? false : null;

  if (!instanceId) return console.error(err("Missing --instance <id>"));
  if (!mockName) return console.error(err('Missing --mock "<name>"'));
  if (enabled === null) return console.error(err("Missing --on or --off"));

  try {
    const { status, body } = await POST("/toggle", { instanceId, mockName, enabled });
    if (status === 200) {
      console.log(ok(`[${instanceId}] "${mockName}" → ${enabled ? "ON" : "OFF"}`));
    } else {
      console.error(err(`Server error ${status}: ${JSON.stringify(body)}`));
    }
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdBulk(params) {
  const instanceId = params.instance;
  const folder = params.folder;
  const enabled = "on" in params ? true : "off" in params ? false : null;

  if (!instanceId) return console.error(err("Missing --instance <id>"));
  if (!folder) return console.error(err('Missing --folder "<name>"'));
  if (enabled === null) return console.error(err("Missing --on or --off"));

  try {
    // Fetch config to get mock names in the folder
    const { status: cfgStatus, body: cfg } = await GET("/config");
    if (cfgStatus !== 200)
      return console.error(err("Could not fetch config from server"));

    const folderMocks = cfg.mocks
      .filter((m) => (m.folder || "Root") === folder)
      .map((m) => m.name);

    if (folderMocks.length === 0) {
      return console.log(warn(`No mocks found in folder "${folder}"`));
    }

    const { status, body } = await POST("/toggle-bulk", {
      instanceId,
      mockNames: folderMocks,
      enabled,
    });
    if (status === 200) {
      console.log(
        ok(
          `[${instanceId}] ${folderMocks.length} mocks in "${folder}" → ${enabled ? "ON" : "OFF"}`
        )
      );
      folderMocks.forEach((name) => console.log(`  ${dim("•")} ${name}`));
    } else {
      console.error(err(`Server error ${status}: ${JSON.stringify(body)}`));
    }
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdList(params) {
  const searchTerm = (params.search || "").toLowerCase();
  const filterInstance = params.instance;

  try {
    const { status, body: cfg } = await GET("/config");
    if (status !== 200) return console.error(err("Could not fetch config from server"));

    let mocks = cfg.mocks;
    if (searchTerm)
      mocks = mocks.filter((m) => m.name.toLowerCase().includes(searchTerm));

    if (mocks.length === 0) {
      return console.log(
        warn(searchTerm ? `No mocks match "${searchTerm}"` : "No mocks found")
      );
    }

    const instances = filterInstance
      ? cfg.instances.filter((i) => i.id === filterInstance)
      : cfg.instances;

    const instanceIds = instances.map((i) => i.id);

    // Header
    const nameWidth = 40;
    const header = `${"Mock".padEnd(nameWidth)} ${instanceIds.map((id) => id.padEnd(8)).join(" ")}`;
    console.log(`\n${bold(header)}`);
    console.log(dim("─".repeat(header.length)));

    // Group by folder
    const groups = {};
    mocks.forEach((m) => {
      const f = m.folder || "Root";
      if (!groups[f]) groups[f] = [];
      groups[f].push(m);
    });

    Object.keys(groups)
      .sort((a, b) => (a === "Root" ? -1 : b === "Root" ? 1 : a.localeCompare(b)))
      .forEach((folder) => {
        console.log(`\n${c.yellow}📁 ${folder}${c.reset}`);
        groups[folder].forEach((m) => {
          const nameStr =
            m.name.length > nameWidth - 2
              ? m.name.slice(0, nameWidth - 5) + "..."
              : m.name;
          const states = instanceIds.map((id) => {
            const on = cfg.states[id]?.[m.name] === true;
            return (on ? `${c.green}ON${c.reset}` : `${c.gray}off${c.reset}`).padEnd(
              8 + (on ? c.green.length + c.reset.length : c.gray.length + c.reset.length)
            );
          });
          const badges = [
            m.hasConflict ? `${c.yellow}⚠ CONFLICT${c.reset}` : "",
            m.delay > 0 ? `${c.magenta}⏱${m.delay}ms${c.reset}` : "",
          ]
            .filter(Boolean)
            .join(" ");

          console.log(`  ${nameStr.padEnd(nameWidth)} ${states.join(" ")} ${badges}`);
        });
      });

    console.log(`\n${dim(`${mocks.length} mocks total`)}\n`);
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdStatus() {
  try {
    const { status, body: cfg } = await GET("/config");
    if (status !== 200) return console.error(err("Could not fetch config"));

    console.log(`\n${bold("Current Instance Status")}\n`);

    // A fresh clone seeds no instances, so this is the *normal* first run, not
    // an error. A bare header with nothing under it reads like the command
    // failed; saying what to do next is the difference.
    if (!cfg.instances.length) {
      console.log(`  ${dim("No instances yet.")}`);
      console.log(
        `  ${dim("Point a device at the proxy, then turn SSL proxying on for a host")}`
      );
      console.log(
        `  ${dim("from the dashboard tree — or add one from its settings popover.")}\n`
      );
      return;
    }

    cfg.instances.forEach((inst) => {
      const settings = cfg.instanceSettings[inst.id];
      const active = settings.isActive;
      const stateIcon = active ? `${c.green}LIVE${c.reset}` : `${c.red}OFF${c.reset}`;
      const onCount = Object.values(cfg.states[inst.id] || {}).filter(Boolean).length;
      const latency = settings.latency || 0;
      const latencyStr =
        latency > 0 ? `  |  Latency: ${c.magenta}+${latency}ms${c.reset}` : "";

      console.log(`  ${bold(inst.name)} ${dim(`[${inst.id}]`)} — ${stateIcon}`);
      console.log(
        `    Port: ${inst.port}  |  Target: ${dim(settings.targetUrl)}  |  Active mocks: ${c.cyan}${onCount}${c.reset}${latencyStr}`
      );
    });
    console.log();
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdHealth() {
  try {
    const { status, body: h } = await GET("/health");
    if (status !== 200) return console.error(err("Server responded with error"));

    const mins = Math.floor(h.uptime / 60);
    const hrs = Math.floor(mins / 60);
    const uptimeStr =
      hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${Math.floor(h.uptime % 60)}s`;

    console.log(`\n${bold("Server Health")} ${c.green}●${c.reset}\n`);
    console.log(`  Status:      ${c.green}${h.status}${c.reset}`);
    console.log(`  Uptime:      ${uptimeStr}`);
    console.log(`  Mock count:  ${c.cyan}${h.mockCount}${c.reset}`);
    console.log(`  Timestamp:   ${dim(h.timestamp)}`);
    console.log(`\n  ${bold("Instances:")}`);
    h.instances.forEach((i) => {
      const st = i.isActive ? `${c.green}LIVE${c.reset}` : `${c.gray}OFF${c.reset}`;
      console.log(`    ${bold(i.name)} ${dim(`[${i.id}]`)} :${i.port}  ${st}`);
    });
    console.log();
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdStandalone(params) {
  const enabled = "on" in params ? true : "off" in params ? false : null;

  try {
    // No flag → just report current state.
    if (enabled === null) {
      const { status, body } = await GET("/standalone");
      if (status === 200) {
        console.log(
          info(`Standalone instances (:3000/:3001/:3002): ${body.enabled ? "ON" : "OFF"}`)
        );
      } else {
        console.error(err("Could not fetch standalone status"));
      }
      return;
    }

    const { status, body } = await POST("/standalone", { enabled });
    if (status === 200) {
      console.log(ok(`Standalone instances → ${body.enabled ? "ON" : "OFF"}`));
    } else {
      console.error(err(`Server error ${status}: ${JSON.stringify(body)}`));
    }
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdLatency(params) {
  const instanceId = params.instance;
  if (!instanceId) return console.error(err("Missing --instance <id>"));

  try {
    // No --ms → just report the current value.
    if (!("ms" in params)) {
      const { status, body } = await GET(`/state/${instanceId}`);
      if (status !== 200)
        return console.error(err(`Server error ${status}: ${JSON.stringify(body)}`));
      const v = body.latency || 0;
      console.log(
        info(`[${instanceId}] simulated latency: ${v > 0 ? `+${v}ms` : "off (0ms)"}`)
      );
      return;
    }

    const ms = parseInt(params.ms, 10);
    if (!Number.isInteger(ms) || ms < 0) {
      return console.error(err("--ms must be a non-negative integer (0 disables)"));
    }
    const { status, body } = await POST("/instance-settings", {
      instanceId,
      latency: ms,
    });
    if (status === 200) {
      console.log(
        ok(
          `[${instanceId}] simulated latency → ${ms > 0 ? `+${ms}ms on every response` : "off"}`
        )
      );
    } else {
      console.error(err(`Server error ${status}: ${JSON.stringify(body)}`));
    }
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdProfiles() {
  try {
    const { status, body } = await GET("/profiles");
    if (status !== 200) return console.error(err("Could not fetch profiles"));

    const names = Object.keys(body);
    if (names.length === 0) {
      return console.log(info("No profiles saved yet. Use profile:save --name <name>"));
    }

    console.log(`\n${bold("Saved Profiles")} ${dim(`(${names.length})`)}\n`);
    names.forEach((name) => {
      const instanceCount = Object.keys(body[name]).length;
      console.log(
        `  ${c.cyan}📋 ${name}${c.reset}  ${dim(`(${instanceCount} instance${instanceCount !== 1 ? "s" : ""})`)}`
      );
    });
    console.log();
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdProfileSave(params) {
  const name = params.name;
  if (!name) return console.error(err('Missing --name "<profile name>"'));

  try {
    const { status } = await POST("/profiles/save", { name });
    if (status === 200) console.log(ok(`Profile "${name}" saved`));
    else console.error(err(`Failed to save profile (${status})`));
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()})`));
  }
}

async function cmdProfileLoad(params) {
  const name = params.name;
  if (!name) return console.error(err('Missing --name "<profile name>"'));

  try {
    const { status, body } = await POST("/profiles/load", { name });
    if (status === 200) console.log(ok(`Profile "${name}" loaded`));
    else console.error(err(`Failed to load profile: ${JSON.stringify(body)}`));
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()})`));
  }
}

async function cmdProfileDelete(params) {
  const name = params.name;
  if (!name) return console.error(err('Missing --name "<profile name>"'));

  try {
    const { status } = await POST("/profiles/delete", { name });
    if (status === 200) console.log(info(`Profile "${name}" deleted`));
    else console.error(err(`Failed to delete profile (${status})`));
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()})`));
  }
}

// ── Blocking ──────────────────────────────────────────────────────────────────
// A block is the one failure this proxy can produce that isn't a response: the
// socket is destroyed, so the caller sees a reset rather than a status. The
// commands below therefore say more than "done" — a prefix rule is easy to
// underestimate, and a rule on a tunneled host never fires at all.

/** Read the rules in play, optionally asking about one path too. */
async function fetchBlocks(host, target) {
  const query = new URLSearchParams({ host });
  if (target) query.set("path", target);
  const { status, body } = await GET(`/hosts/blocks?${query}`);
  return status === 200 ? body : { blocks: [], ssl: false, rule: null, blocked: false };
}

/** Shared tail: the two things about a new rule that surprise people. */
function reportBlockContext(host, before, after) {
  // Rules the new one now covers are dropped — see utils/blocking.js. Silently
  // shrinking the list would read as the CLI having lost them.
  const absorbed = before.blocks.filter((rule) => !after.blocks.includes(rule));
  if (absorbed.length) {
    console.log(
      dim(`   absorbed ${absorbed.join(", ")} — the new rule already covers them`)
    );
  }
  if (after.ssl !== true) {
    console.log(
      warn(
        `SSL proxying is off for ${host} — the rule is stored but never fires.\n` +
          `   Blocking runs inside the decrypted pipeline; a tunneled host never reaches it.\n` +
          `   Turn SSL on from the dashboard tree (right-click the host).`
      )
    );
  }
}

async function cmdBlock(params) {
  const host = params.host;
  const target = params.path;
  if (!host || host === true) return console.error(err("Missing --host <hostname>"));
  if (!target || target === true) return console.error(err("Missing --path </path>"));

  try {
    const before = await fetchBlocks(host, target);
    const { status, body: after } = await POST("/hosts/block", {
      host,
      path: target,
      blocked: true,
    });
    if (status !== 200) {
      return console.error(err(`Server error ${status}: ${JSON.stringify(after)}`));
    }

    if (before.blocked) {
      console.log(info(`${host}${before.path} is already blocked by ${before.rule}`));
    } else {
      const rule = after.blocks.find((r) => !before.blocks.includes(r)) || before.path;
      // Only claim the path dies when it actually will. On a tunneled host the
      // rule is stored and inert, and saying otherwise is the one way this
      // feature lies to you — reportBlockContext explains why below.
      console.log(
        after.ssl === true
          ? `${c.red}⛔${c.reset} ${bold(`${host}${rule}`)} — this path and everything under it now dies`
          : `${c.yellow}⛔${c.reset} ${bold(`${host}${rule}`)} — rule stored, but ${bold("not in effect")}`
      );
      if (after.ssl === true) {
        console.log(
          dim(
            `   calls get no response at all: the connection is destroyed, not answered`
          )
        );
      }
    }
    reportBlockContext(host, before, after);
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdUnblock(params) {
  const host = params.host;
  const target = params.path;
  if (!host || host === true) return console.error(err("Missing --host <hostname>"));
  if (!target || target === true) return console.error(err("Missing --path </path>"));

  try {
    const before = await fetchBlocks(host, target);
    const { status, body: after } = await POST("/hosts/block", {
      host,
      path: target,
      blocked: false,
    });
    if (status !== 200) {
      return console.error(err(`Server error ${status}: ${JSON.stringify(after)}`));
    }

    if (before.blocks.length > after.blocks.length) {
      console.log(ok(`${host}${before.path} unblocked`));
      // Lifting a rule can leave the path blocked anyway, by an ancestor. Ask
      // the server rather than re-deriving the prefix rule here — it is the one
      // that decides, and a second copy of it is a second chance to be wrong.
      const now = await fetchBlocks(host, before.path);
      if (now.blocked) {
        console.log(
          warn(`still blocked by ${now.rule} — lift that rule to bring it back`)
        );
      }
    } else if (before.blocked) {
      // Unblocking is exact on purpose: a click on a child must not silently
      // lift its whole parent tree.
      console.log(
        warn(
          `No rule named ${before.path} — it is blocked by ${before.rule}.\n` +
            `   Lift that one instead: npm run mock -- unblock --host ${host} --path ${before.rule}`
        )
      );
    } else {
      console.log(info(`${host}${before.path} was not blocked`));
    }
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

async function cmdBlocks(params) {
  const host = params.host && params.host !== true ? params.host : null;
  const target = params.path && params.path !== true ? params.path : null;
  if (target && !host) return console.error(err("--path needs --host <hostname>"));

  try {
    // One path: the only question is whether a call to it would die, and which
    // rule kills it. The server answers, so this can never disagree with what
    // the proxy actually enforces.
    if (target) {
      const res = await fetchBlocks(host, target);
      console.log(
        res.blocked
          ? `${c.red}⛔ ${host}${res.path} → DIES${c.reset} ${dim(`(blocked by ${res.rule})`)}`
          : `${c.green}●${c.reset} ${host}${res.path} → reachable`
      );
      if (res.blocked && res.ssl !== true) {
        console.log(warn(`…but SSL is off for ${host}, so the rule never fires`));
      }
      return;
    }

    if (host) {
      const res = await fetchBlocks(host);
      if (!res.blocks.length) return console.log(info(`No blocked paths on ${host}`));
      console.log(`\n${bold(host)} ${res.ssl ? "" : dim("(SSL off — rules inert)")}`);
      res.blocks.forEach((rule) => console.log(`  ${c.red}⛔${c.reset} ${rule}`));
      console.log();
      return;
    }

    const { status, body } = await GET("/hosts/blocks");
    if (status !== 200) return console.error(err("Could not fetch blocks"));
    const hosts = Object.keys(body.blocks || {});
    if (!hosts.length) {
      return console.log(
        info("Nothing is blocked. Use block --host <host> --path </path>")
      );
    }
    console.log(
      `\n${bold("Blocked paths")} ${dim(`(${hosts.length} host${hosts.length !== 1 ? "s" : ""})`)}\n`
    );
    hosts.sort().forEach((name) => {
      console.log(`  ${bold(name)}`);
      body.blocks[name].forEach((rule) =>
        console.log(`    ${c.red}⛔${c.reset} ${rule}`)
      );
    });
    console.log();
  } catch (e) {
    console.error(err(`Connection failed (${serverLabel()}) — is the server running?`));
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
// ── Running saved requests ────────────────────────────────────────────────────
// `run` is the reason this feature has a CLI at all: it is the shape a CI job
// wants. It loops POST /saved-requests/:id/send — the same route the dashboard
// runner loops — in order, one at a time, and **exits non-zero** when anything
// failed. There is no server-side runner to call instead, on purpose: order and
// progress belong to whoever is watching the run.
//
// The one thing this prints that the dashboard shows more quietly: a request
// with **no expectation is not a pass**. It is counted apart and marked apart,
// because "8 sent, 8 ok" for a suite that asserts nothing is precisely the
// false green the whole feature exists to prevent.

const PASS = `${c.green}✓${c.reset}`;
const FAIL = `${c.red}✗${c.reset}`;
const UNCHECKED = `${c.gray}–${c.reset}`;

async function fetchSaved() {
  const { status, body } = await GET("/saved-requests");
  if (status !== 200) throw new Error(`Could not read saved requests (HTTP ${status})`);
  return body.requests || [];
}

/**
 * `--var name=value`, repeated, into the map the send route takes.
 *
 * Split on the **first** `=` only: a value is arbitrary text and routinely
 * contains one — a base64 credential ends in them.
 *
 * Only the shape is checked here. Whether a name is usable is
 * `utils/template.js`'s call, made in one place for the dashboard, this and the
 * clients alike; re-deriving the rule here is how the two come to disagree.
 */
function parseVars(list) {
  const out = {};
  for (const raw of list) {
    if (raw === true) throw new Error("--var needs a name=value pair");
    const at = String(raw).indexOf("=");
    if (at < 1) {
      throw new Error(`--var "${raw}" is not a name=value pair`);
    }
    out[String(raw).slice(0, at)] = String(raw).slice(at + 1);
  }
  return out;
}

/** Read a JSON Schema off disk, for keeping schemas in the caller's own repo. */
function readSchemaFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`Could not read ${file}: ${e.message}`, { cause: e });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`, { cause: e });
  }
}

/**
 * Send one saved request and print its row.
 * @returns {"passed"|"failed"|"unchecked"}
 */
async function runOne(record, override, variables) {
  const started = Date.now();
  const { status, body } = await POST(
    `/saved-requests/${encodeURIComponent(record.id)}/send`,
    {
      ...(override === undefined ? {} : { expect: override }),
      // Merged over the request's own by the route, so a run supplies the one
      // value the file should not be carrying and nothing else.
      ...(variables ? { variables } : {}),
    }
  );
  const ms = Date.now() - started;
  const label = `${record.method || "GET"} ${record.path}`;
  const name = bold(record.name.padEnd(28).slice(0, 28));

  if (status !== 200) {
    // The readable ones land here: SSL off for the target (409), the instance
    // gone (404), a stored schema that cannot be honoured (400).
    console.log(`  ${FAIL} ${name} ${dim(label)}`);
    console.log(`       ${c.red}${(body && body.error) || `HTTP ${status}`}${c.reset}`);
    return "failed";
  }

  const verdict = body.expect;
  const mark = !verdict ? UNCHECKED : verdict.passed ? PASS : FAIL;
  const code = body.status < 300 ? c.green : body.status < 500 ? c.yellow : c.red;
  console.log(
    `  ${mark} ${name} ${dim(label.padEnd(34).slice(0, 34))} ` +
      `${code}${body.status}${c.reset} ${dim(`${ms} ms`)}`
  );

  if (verdict && !verdict.passed) {
    verdict.errors.forEach((line) => console.log(`       ${c.red}${line}${c.reset}`));
    return "failed";
  }
  return verdict ? "passed" : "unchecked";
}

async function cmdRun(params) {
  let override;
  if (params["schema-file"] || params.status) {
    if (!params.request || params.request === true) {
      return console.error(
        err("--schema-file and --status apply to a single --request <id>")
      );
    }
    try {
      override = {};
      if (params["schema-file"]) override.schema = readSchemaFile(params["schema-file"]);
      if (params.status) override.status = parseInt(params.status, 10);
    } catch (e) {
      return console.error(err(e.message));
    }
  }
  // Distinct from "no override": an explicit null sends with nothing checked.
  if (params["no-check"]) override = null;

  // Unlike --schema-file and --status, this is *not* restricted to a single
  // --request. A schema is a statement about one specific response; a variable
  // is an input the whole flow may need — the token every request in a
  // collection carries is exactly the case this exists for.
  let variables;
  if (params.var) {
    try {
      variables = parseVars(params.var);
    } catch (e) {
      return console.error(err(e.message));
    }
  }

  let records;
  let title;

  try {
    if (params.request && params.request !== true) {
      const all = await fetchSaved();
      const one = all.find((r) => r.id === params.request);
      if (!one) {
        return console.error(
          err(`No saved request with id "${params.request}". Try: npm run mock -- checks`)
        );
      }
      records = [one];
      title = one.name;
    } else if (params.collection && params.collection !== true) {
      const { status, body } = await GET("/collections");
      if (status !== 200)
        return console.error(err(`Could not read collections (HTTP ${status})`));
      const group = (body.collections || []).find(
        (g) => g.id === params.collection || g.name === params.collection
      );
      if (!group) {
        const names = (body.collections || []).map((g) => g.id).join(", ") || "none";
        return console.error(
          err(`No collection "${params.collection}". Known: ${names}`)
        );
      }
      records = group.requests;
      title = group.name;
    } else if (params.all) {
      records = await fetchSaved();
      title = "Every saved request";
    } else {
      return console.error(
        err("Pick what to run: --collection <id>, --request <id>, or --all")
      );
    }
  } catch (e) {
    return console.error(err(e.message));
  }

  if (!records.length) {
    return console.log(warn(`${title} has nothing to run.`));
  }

  console.log(
    `\n${bold(`▶ ${title}`)} ${dim(`— ${records.length} request${records.length === 1 ? "" : "s"} · ${serverLabel()}`)}\n`
  );

  const tally = { passed: 0, failed: 0, unchecked: 0 };
  // Sequential and awaited: "log in, then call the thing that needs the token"
  // is the shape these have, and firing them at once answers a different
  // question. Not stop-on-first-failure either — a run is how you find out
  // *where* a flow breaks.
  for (const record of records) {
    tally[await runOne(record, override, variables)]++;
  }

  const parts = [`${records.length} sent`];
  if (tally.passed) parts.push(`${c.green}${tally.passed} passed${c.reset}`);
  if (tally.failed) parts.push(`${c.red}${tally.failed} failed${c.reset}`);
  // Always printed when there are any, never folded into "passed": a request
  // with no expectation was not checked, and saying otherwise is the lie.
  if (tally.unchecked) parts.push(`${c.gray}${tally.unchecked} unchecked${c.reset}`);
  console.log(`\n${parts.join(dim(" · "))}\n`);

  if (tally.failed) process.exitCode = 1;
}

async function cmdChecks(params) {
  let records;
  try {
    records = await fetchSaved();
  } catch (e) {
    return console.error(err(e.message));
  }

  const term = typeof params.search === "string" ? params.search.toLowerCase() : null;
  const shown = term
    ? records.filter(
        (r) =>
          r.name.toLowerCase().includes(term) ||
          String(r.path || "")
            .toLowerCase()
            .includes(term)
      )
    : records;

  if (!shown.length) {
    return console.log(
      info(term ? `Nothing matches "${params.search}".` : "Nothing saved yet.")
    );
  }

  console.log(`\n${bold("Saved requests")} ${dim(`(server: ${serverLabel()})`)}\n`);

  let checked = 0;
  shown.forEach((r) => {
    const e = r.expect;
    if (e) checked++;
    const what = !e
      ? dim("no check")
      : [e.status ? `status ${e.status}` : null, e.schema ? "schema" : null]
          .filter(Boolean)
          .join(" + ");
    console.log(
      `  ${e ? `${c.cyan}{ }${c.reset}` : "   "} ${bold(r.name.padEnd(28).slice(0, 28))} ` +
        `${dim(`${r.method || "GET"} ${r.path}`.padEnd(34).slice(0, 34))} ${what}`
    );
  });

  const bare = shown.length - checked;
  console.log(
    `\n${checked} of ${shown.length} check the response.` +
      (bare
        ? ` ${dim(`${bare} would report green without looking at it — add an expectation from the dashboard's Expect tab.`)}`
        : "")
  );
  console.log();
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const params = parseArgs(argv.slice(1));

  if (!command || command === "--help" || command === "help") {
    showHelp();
    return;
  }

  switch (command) {
    case "toggle":
      await cmdToggle(params);
      break;
    case "bulk":
      await cmdBulk(params);
      break;
    case "list":
      await cmdList(params);
      break;
    case "status":
      await cmdStatus(params);
      break;
    case "health":
      await cmdHealth();
      break;
    case "standalone":
      await cmdStandalone(params);
      break;
    case "latency":
      await cmdLatency(params);
      break;
    case "block":
      await cmdBlock(params);
      break;
    case "unblock":
      await cmdUnblock(params);
      break;
    case "blocks":
      await cmdBlocks(params);
      break;
    case "run":
      await cmdRun(params);
      break;
    case "checks":
      await cmdChecks(params);
      break;
    case "profiles":
      await cmdProfiles();
      break;
    case "profile:save":
      await cmdProfileSave(params);
      break;
    case "profile:load":
      await cmdProfileLoad(params);
      break;
    case "profile:delete":
      await cmdProfileDelete(params);
      break;
    default:
      console.error(
        err(`Unknown command: "${command}". Run with --help to see available commands.`)
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(err(`Unexpected error: ${e.message}`));
  process.exit(1);
});
