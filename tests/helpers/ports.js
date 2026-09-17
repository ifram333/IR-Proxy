/**
 * Port blocks for tests that boot a real server.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every test file that calls `startProxyServer` used to pick its own constant —
 * 18700, 18800, 18900, 18950 — chosen by eye and spaced by hand. Two things
 * make that fragile in a way the constants do not advertise:
 *
 *   • `startProxyServer` does not take the port it is given, it **scans**
 *     upward from it (`findAvailablePort`, `MAX_PORT_SCAN` = 20 wide). So a
 *     constant is not a port, it is the bottom of a range — and two constants
 *     50 apart were two ranges that overlap.
 *   • A neighbour inside the range breaks the one file whose whole subject is
 *     the scan: `single-instance.test.js` asserts a second boot lands *above*
 *     its base, and it does not when somebody else got there first. That is a
 *     failure this suite has actually produced (`Expected: > 18950, Received:
 *     18950`), and adding a fifth proxy-booting file was enough to cause it.
 *
 * **This is not what made the suite flaky day to day.** That was supertest
 * binding a fresh ephemeral port per request; see `helpers/serve.js`, which is
 * the fix for it. What this file buys is that the ranges cannot overlap by
 * construction, so nobody has to remember the spacing when adding a test.
 *
 * ## The allocation
 *
 * One block per **jest worker**, not per file. Files inside a worker run
 * strictly one after another and each closes its server in `afterAll`, so they
 * can share a block safely; files that run *concurrently* are by definition in
 * different workers, which is the only case that could collide. Nothing has to
 * be registered here when a test file is added — needing a human to remember
 * the spacing was the previous scheme's real flaw.
 *
 * `JEST_WORKER_ID` is 1-based and is set for `--runInBand` too, so serial runs
 * simply take the first block. Two *separate* jest processes on one machine
 * would both start at block 1 and collide; that is not a supported way to run
 * this suite, and it is how the overlap above was reproduced on purpose.
 *
 * @example
 *   const { basePort } = require("./helpers/ports");
 *   proxy = await startProxyServer({ …, preferredPort: basePort() });
 */

"use strict";

/**
 * Bottom of the test range. High enough to be clear of the proxy's own default
 * (8888) and of anything a developer is likely to have running.
 */
const FLOOR = 18400;

/**
 * Ports per worker, and the arithmetic behind the number:
 * `single-instance.test.js` boots from `base + 20` (it parks a decoy there
 * first), and any boot scans `MAX_PORT_SCAN` = 20 further. So the highest port
 * a block can reach is `base + 40`, and the stride has to clear that with room
 * left over rather than land exactly on it.
 */
const STRIDE = 64;

/** 1-based, and always set by jest — including under `--runInBand`. */
const workerId = () => Number(process.env.JEST_WORKER_ID || 1);

/**
 * The bottom of this worker's block. Pass it as `preferredPort`.
 *
 * @param {number} [offset] a port inside the block, for a test that needs more
 *   than one. Throws rather than silently handing back a port in the next
 *   worker's block — a test that needs more room should get a wider stride, not
 *   a neighbour's ports.
 */
function basePort(offset = 0) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= STRIDE) {
    throw new RangeError(`ports: offset must be 0…${STRIDE - 1}, got ${offset}`);
  }
  return FLOOR + (workerId() - 1) * STRIDE + offset;
}

module.exports = { FLOOR, STRIDE, basePort, workerId };
