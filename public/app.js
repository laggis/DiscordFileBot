"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
let secret = "";
let resources = [];
let editingId = null;
let guildId = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Restore session if the user previously logged in
  const saved = sessionStorage.getItem("panel_secret");
  if (saved) {
    secret = saved;
    boot();
  }

  // Enter key submits login
  document.getElementById("secret-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });

  // Click outside modal card to close
  document.getElementById("edit-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeEdit();
  });
});

async function boot() {
  try {
    await loadStatus();
  } catch {
    // Secret wrong or panel not reachable — go back to login
    return showLogin();
  }
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  await loadResources();
  // Refresh bot status every 30 s
  setInterval(loadStatus, 30_000);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  const input = document.getElementById("secret-input");
  const errEl = document.getElementById("login-error");

  secret = input.value.trim();
  errEl.classList.add("hidden");

  if (!secret) {
    errEl.textContent = "Please enter your secret.";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    await loadStatus();
    sessionStorage.setItem("panel_secret", secret);
    boot();
  } catch {
    secret = "";
    errEl.textContent = "Invalid secret — please try again.";
    errEl.classList.remove("hidden");
    input.value = "";
    input.focus();
  }
}

function showLogin() {
  document.getElementById("login").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

function logout() {
  sessionStorage.removeItem("panel_secret");
  secret = "";
  resources = [];
  guildId = null;
  showLogin();
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(method, url, body = null) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Panel-Secret": secret,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    logout();
    throw new Error("Unauthorized");
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
    toast(err.message, "error");
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

  // Attach button listeners after DOM insertion (avoids inline JS with IDs)
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

  // Show remaining hours (0 = unlimited)
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

// Called by the form's onsubmit
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
    toast(err.message, "error");
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
    // Re-render respecting any active search filter
    filterResources();
  } catch (err) {
    toast(err.message, "error");
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
    toast(err.message, "error");
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
