"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
// NOTE: No secret is ever stored here. Auth is handled by an httpOnly cookie
// that the browser manages automatically — JavaScript cannot read it.
let resources = [];
let editingId = null;
let guildId = null;
let lockoutInterval = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Try to resume an existing session (the browser sends the cookie automatically)
  boot();

  document.getElementById("secret-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });

  document.getElementById("edit-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeEdit();
  });
});

async function boot() {
  try {
    await loadStatus(); // 401 if no valid session → caught below
  } catch {
    return showLogin();
  }
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  await loadResources();
  setInterval(loadStatus, 30_000);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  const input = document.getElementById("secret-input");
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  const secret = input.value.trim();

  errEl.classList.add("hidden");

  if (!secret) {
    showLoginError("Please enter your secret.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });

    const data = await res.json();

    if (!res.ok) {
      showLoginError(data.error || "Login failed.");

      // Start countdown if we hit the lockout
      if (res.status === 429 && data.lockedUntil) {
        startLockoutCountdown(data.lockedUntil);
      }
      return;
    }

    // Success — clear the input and launch the app
    input.value = "";
    clearLockout();
    boot();
  } catch {
    showLoginError("Could not reach the server. Is the bot running?");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    /* best-effort */
  }
  showLogin();
}

function showLogin() {
  resources = [];
  guildId = null;
  clearLockout();
  document.getElementById("login").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("secret-input").focus();
}

// ─── Lockout countdown ────────────────────────────────────────────────────────
function startLockoutCountdown(lockedUntil) {
  clearLockout();
  const btn = document.getElementById("login-btn");
  btn.disabled = true;

  function tick() {
    const secsLeft = Math.ceil((lockedUntil - Date.now()) / 1000);
    if (secsLeft <= 0) {
      clearLockout();
      showLoginError("Lockout expired — you may try again.");
      return;
    }
    const m = String(Math.floor(secsLeft / 60)).padStart(2, "0");
    const s = String(secsLeft % 60).padStart(2, "0");
    showLoginError(`Too many failed attempts. Try again in ${m}:${s}.`);
  }

  tick();
  lockoutInterval = setInterval(tick, 1000);
}

function clearLockout() {
  clearInterval(lockoutInterval);
  lockoutInterval = null;
  const btn = document.getElementById("login-btn");
  if (btn) btn.disabled = false;
}

function showLoginError(msg) {
  const el = document.getElementById("login-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ─── API helper ───────────────────────────────────────────────────────────────
// The session cookie is sent automatically by the browser (same-origin).
// No secret is ever placed in a JavaScript variable or request header.
async function api(method, url, body = null) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    // Session expired server-side — send user back to login
    showLogin();
    toast("Session expired — please log in again.", "info");
    throw new Error("Session expired");
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Status ───────────────────────────────────────────────────────────────────
async function loadStatus() {
  const s = await api("GET", "/api/status");
  guildId = s.guildId;

  const dot = document.getElementById("bot-status");
  const ping = document.getElementById("stat-ping");

  if (s.online) {
    dot.textContent = `🟢 ${s.tag}`;
    dot.className = "status-dot online";
    ping.textContent = `${s.ping} ms`;
  } else {
    dot.textContent = "🔴 Offline";
    dot.className = "status-dot offline";
    ping.textContent = "—";
  }
}

// ─── Resources ────────────────────────────────────────────────────────────────
async function loadResources() {
  try {
    resources = await api("GET", "/api/resources");
    updateStats();
    renderTable(resources);
  } catch (err) {
    if (err.message !== "Session expired") toast(err.message, "error");
  }
}

function updateStats() {
  const totalDl = resources.reduce((n, r) => n + (r.downloads || 0), 0);
  document.getElementById("stat-total").textContent = resources.length;
  document.getElementById("stat-downloads").textContent = totalDl;
}

function renderTable(list) {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";

  if (!list.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty">No resources found.</td></tr>';
    return;
  }

  for (const r of list) {
    const tr = document.createElement("tr");

    // Expiry badge
    let expiryHtml;
    if (!r.expires_at) {
      expiryHtml = '<span class="badge badge-ok">∞ Unlimited</span>';
    } else {
      const rem = r.expires_at - Date.now() / 1000;
      if (rem <= 0) {
        expiryHtml = '<span class="badge badge-exp">Expired</span>';
      } else {
        const h = (rem / 3600).toFixed(1);
        expiryHtml = `<span class="badge badge-warn">${h} h</span>`;
      }
    }

    // Category badge
    const catHtml = r.category
      ? `<span class="badge badge-cat">${esc(r.category)}</span>`
      : `<span class="muted">—</span>`;

    // File / URL display
    const fileText = r.filename || r.direct_url || "—";

    // Jump-to-Discord link
    const discordHtml =
      guildId && r.channel_id && r.message_id
        ? `<a href="https://discord.com/channels/${guildId}/${r.channel_id}/${r.message_id}"
            target="_blank" rel="noopener" title="View in Discord">↗</a>`
        : "";

    tr.innerHTML = `
      <td class="td-title">
        <strong>${esc(r.title || "Untitled")}</strong>
        <div class="td-desc">${esc(r.description || "")}</div>
      </td>
      <td>${catHtml}</td>
      <td class="td-file"><code title="${esc(fileText)}">${esc(fileText)}</code></td>
      <td>${r.downloads || 0}</td>
      <td>${expiryHtml}</td>
      <td class="td-actions">
        <button class="btn btn-ghost btn-sm" data-edit="${esc(r.id)}">✏️ Edit</button>
        <button class="btn btn-danger"       data-del="${esc(r.id)}" data-title="${esc(r.title || "this resource")}">🗑️</button>
        ${discordHtml}
      </td>
    `;

    tbody.appendChild(tr);
  }

  tbody
    .querySelectorAll("[data-edit]")
    .forEach((btn) =>
      btn.addEventListener("click", () => openEdit(btn.dataset.edit)),
    );
  tbody
    .querySelectorAll("[data-del]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        confirmDelete(btn.dataset.del, btn.dataset.title),
      ),
    );
}

// ─── Search ───────────────────────────────────────────────────────────────────
function filterResources() {
  const q = document.getElementById("search").value.toLowerCase();
  if (!q) {
    renderTable(resources);
    return;
  }
  renderTable(
    resources.filter(
      (r) =>
        (r.title || "").toLowerCase().includes(q) ||
        (r.filename || "").toLowerCase().includes(q) ||
        (r.category || "").toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q) ||
        (r.direct_url || "").toLowerCase().includes(q),
    ),
  );
}

// ─── Edit modal ───────────────────────────────────────────────────────────────
function openEdit(id) {
  const r = resources.find((x) => x.id === id);
  if (!r) return;
  editingId = id;

  document.getElementById("edit-title").value = r.title || "";
  document.getElementById("edit-description").value = r.description || "";
  document.getElementById("edit-filename").value = r.filename || "";
  document.getElementById("edit-direct-url").value = r.direct_url || "";
  document.getElementById("edit-category").value = r.category || "";

  if (!r.expires_at) {
    document.getElementById("edit-expiry").value = "0";
  } else {
    const rem = r.expires_at - Date.now() / 1000;
    document.getElementById("edit-expiry").value =
      rem > 0 ? (rem / 3600).toFixed(1) : "0";
  }

  document.getElementById("edit-modal").classList.remove("hidden");
  document.getElementById("edit-title").focus();
}

function closeEdit() {
  editingId = null;
  document.getElementById("edit-modal").classList.add("hidden");
}

async function saveEdit(e) {
  e.preventDefault();
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const expiryVal = parseFloat(document.getElementById("edit-expiry").value);
    await api("PUT", `/api/resources/${editingId}`, {
      title: document.getElementById("edit-title").value.trim(),
      description: document.getElementById("edit-description").value.trim(),
      filename: document.getElementById("edit-filename").value.trim(),
      direct_url: document.getElementById("edit-direct-url").value.trim(),
      category: document.getElementById("edit-category").value.trim(),
      expirationHours: isNaN(expiryVal) ? 0 : expiryVal,
    });
    toast("Resource updated successfully!");
    closeEdit();
    await loadResources();
  } catch (err) {
    if (err.message !== "Session expired") toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Changes";
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function confirmDelete(id, title) {
  if (
    !confirm(`Delete "${title}"?\n\nThis will also remove the Discord message.`)
  )
    return;
  doDelete(id);
}

async function doDelete(id) {
  try {
    await api("DELETE", `/api/resources/${id}`);
    toast("Resource deleted.");
    resources = resources.filter((r) => r.id !== id);
    updateStats();
    filterResources();
  } catch (err) {
    if (err.message !== "Session expired") toast(err.message, "error");
  }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
async function triggerSync() {
  const btn = document.getElementById("sync-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Syncing…";

  try {
    const s = await api("POST", "/api/sync");
    toast(
      `Sync done — ${s.updated} updated, ${s.removed} removed` +
        (s.errors ? `, ${s.errors} error(s)` : ""),
    );
    await loadResources();
  } catch (err) {
    if (err.message !== "Session expired") toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Sync";
  }
}

// ─── Toasts ───────────────────────────────────────────────────────────────────
function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 420);
  }, 3500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
