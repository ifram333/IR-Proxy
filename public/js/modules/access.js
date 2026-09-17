/**
 * access.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The "a machine wants in" prompt.
 *
 * One queue, one modal. Several devices can be waiting at once — a phone and a
 * laptop hitting the proxy together is ordinary — so requests stack and the
 * modal works through them, rather than fighting over the same box.
 *
 * Everything rendered here (IP, path, user-agent) comes off the wire from the
 * machine being asked about, so it is built as DOM text. A user-agent is a
 * perfect place to hide markup, and this is the one dialog whose whole job is to
 * be read carefully before clicking.
 */

import { api, toast, showConfirm } from "./util.js";

/** Requests waiting for an answer, oldest first. */
let _queue = [];
let _current = null;

const el = (id) => document.getElementById(id);

/** Pull whatever is already waiting — the server may have been asked before
 *  this dashboard was even open. */
export async function initAccess() {
  const state = await fetchAccess();
  if (!state) return;
  (state.pending || []).forEach(enqueue);
  showNext();
  renderApprovedCount(state);
}

/**
 * `GET /__admin/access`, or null when this dashboard can't ask.
 *
 * A 403 is the normal answer for a dashboard opened over the network: only
 * loopback may see or change who is approved. Not an error to report — the rest
 * of the page works fine without it.
 */
async function fetchAccess() {
  try {
    const res = await api("/__admin/access");
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** The count on the settings-popover button, hidden when there is nothing. */
function renderApprovedCount(access) {
  const badge = el("approved-count");
  const button = el("btn-approved-clients");
  if (!badge || !button) return;

  // Hidden entirely when this dashboard can't manage access — a dead button is
  // worse than no button.
  button.hidden = !access;
  const count = access?.allowed?.length || 0;
  badge.textContent = count ? String(count) : "";
}

/** Feed one SSE `access` frame in. */
export function handleAccessEvent(event) {
  if (!event || typeof event !== "object") return;

  if (event.type === "pending") {
    enqueue(event);
    showNext();
    return;
  }
  // An approval elsewhere changes the list, and the badge shouldn't wait for a
  // reload to say so.
  if (event.type === "revoked" || (event.type === "resolved" && event.granted)) {
    refreshApproved();
  }
  // Answered or timed out elsewhere — another tab, or the 60s cap. Drop it so
  // nobody is asked about a decision that has already been made.
  if (event.type === "resolved") {
    _queue = _queue.filter((entry) => entry.id !== event.id);
    if (_current?.id === event.id) {
      _current = null;
      close();
      showNext();
    }
  }
}

function enqueue(entry) {
  if (!entry?.id) return;
  if (_current?.id === entry.id) return;
  if (_queue.some((queued) => queued.id === entry.id)) return;
  _queue.push(entry);
}

function showNext() {
  if (_current || _queue.length === 0) return;
  _current = _queue.shift();
  render(_current);
  el("access-modal").style.display = "flex";
}

function render(entry) {
  el("access-ip").textContent = entry.ip;
  el("access-path").textContent = entry.path;

  const ua = el("access-ua");
  ua.textContent = entry.ua || "(no user agent)";
  ua.title = entry.ua || "";

  const more = el("access-more");
  const waiting = Number(entry.waiting) || 1;
  more.textContent =
    waiting > 1 ? `${waiting} requests from this machine are waiting.` : "";

  const remember = el("access-remember");
  if (remember) remember.checked = false;

  const queued = el("access-queue");
  queued.textContent = _queue.length
    ? `${_queue.length} other machine${_queue.length === 1 ? "" : "s"} also waiting.`
    : "";
}

function close() {
  const modal = el("access-modal");
  if (modal) modal.style.display = "none";
}

/**
 * Answer the request on screen.
 *
 * The modal closes before the round trip: the answer is already decided, and
 * leaving a dialog up while the network settles just invites a second click.
 */
export async function resolveAccess(allow) {
  const entry = _current;
  _current = null;
  close();
  if (!entry) return;

  const remember = allow && el("access-remember")?.checked === true;

  try {
    const res = await api("/__admin/access/decision", {
      method: "POST",
      body: { id: entry.id, allow, remember },
    });
    if (res.ok) {
      toast(
        allow
          ? `Allowed ${entry.ip}${remember ? " (remembered)" : " for this session"}`
          : `Denied ${entry.ip}`,
        allow ? "success" : "info"
      );
    } else if (res.status === 404) {
      // It timed out while the dialog was open. Say so rather than reporting a
      // failure the user can do nothing about.
      toast(`That request from ${entry.ip} had already expired`, "info");
    } else {
      const { error } = await res.json().catch(() => ({}));
      toast(error || "Could not record that decision", "error");
    }
  } catch (_) {
    toast("Could not reach the proxy to record that decision", "error");
  }

  showNext();
}

// ── Approved devices ─────────────────────────────────────────────────────────

/** Re-read the list and repaint whatever is showing it. */
async function refreshApproved() {
  const access = await fetchAccess();
  renderApprovedCount(access);
  if (el("clients-modal")?.style.display === "flex") renderClients(access);
}

export async function openApprovedClients() {
  window.closeSettings?.();
  el("clients-modal").style.display = "flex";
  renderClients(await fetchAccess());
}

export function closeApprovedClients() {
  const modal = el("clients-modal");
  if (modal) modal.style.display = "none";
}

/**
 * Built as DOM, like every other list here.
 *
 * The distinction on each row is the point: a **remembered** entry survives a
 * restart and lives in state.json, a session one disappears when the proxy does.
 * Someone auditing this list needs to know which is which before deciding what
 * to leave behind.
 */
function renderClients(access) {
  const list = el("clients-list");
  const revokeAll = el("clients-revoke-all");
  if (!list) return;

  list.replaceChildren();

  if (!access) {
    const note = document.createElement("p");
    note.className = "clients-empty";
    note.textContent = "Only the machine running the proxy can manage approved devices.";
    list.appendChild(note);
    if (revokeAll) revokeAll.hidden = true;
    return;
  }

  const allowed = access.allowed || [];
  const remembered = new Set(access.remembered || []);
  if (revokeAll) revokeAll.hidden = allowed.length === 0;

  if (allowed.length === 0) {
    const note = document.createElement("p");
    note.className = "clients-empty";
    note.textContent =
      "No other machine has been approved. Requests from one will ask first.";
    list.appendChild(note);
    return;
  }

  allowed.forEach((ip) => {
    const row = document.createElement("div");
    row.className = "clients-row";

    const label = document.createElement("div");
    label.className = "clients-label";

    const address = document.createElement("span");
    address.className = "clients-ip";
    address.textContent = ip;

    const scope = document.createElement("span");
    const durable = remembered.has(ip);
    scope.className = `clients-scope${durable ? " durable" : ""}`;
    scope.textContent = durable ? "remembered" : "this session";
    scope.title = durable
      ? "Saved in state.json — it survives a restart. Addresses get reassigned, so re-check it now and then."
      : "Approved without “remember”, so it's forgotten when the proxy restarts.";

    label.append(address, scope);

    const revoke = document.createElement("button");
    revoke.className = "btn btn-ghost btn-sm btn-danger-text";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => revokeClient(ip));

    row.append(label, revoke);
    list.appendChild(row);
  });
}

export async function revokeClient(ip) {
  const res = await api(`/__admin/access/${encodeURIComponent(ip)}`, {
    method: "DELETE",
  });
  if (!res.ok) return toast("Could not revoke that device", "error");
  toast(`${ip} revoked`, "info");
  await refreshApproved();
}

export async function revokeAllClients() {
  const access = await fetchAccess();
  const allowed = access?.allowed || [];
  if (!allowed.length) return;

  const ok = await showConfirm(
    `Revoke all ${allowed.length} approved device${allowed.length === 1 ? "" : "s"}?\n\n` +
      `They'll be asked again on their next request.`
  );
  if (!ok) return;

  // Sequential rather than parallel: each one persists state.json, and a dozen
  // concurrent writes to the same file is a race for no benefit.
  for (const ip of allowed) {
    await api(`/__admin/access/${encodeURIComponent(ip)}`, { method: "DELETE" });
  }
  toast(`${allowed.length} device(s) revoked`, "info");
  await refreshApproved();
}
