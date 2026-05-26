const deploymentsEl = document.getElementById("deployments");
const decisionsEl = document.getElementById("decisions");
const restartsEl = document.getElementById("restarts-today");
const scalesEl = document.getElementById("scales-today");
const alertsEl = document.getElementById("alerts-today");
const logTailEl = document.getElementById("log-tail");
const logStatusEl = document.getElementById("log-status");
const lastUpdatedEl = document.getElementById("last-updated");

const POLL_INTERVAL_MS = 8000;

function formatTimestamp(timestamp) {
  if (!timestamp) return "-";
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

function renderDeployments(items) {
  deploymentsEl.innerHTML = "";
  if (!items.length) {
    deploymentsEl.innerHTML = "<p>No deployments found.</p>";
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "deployment-card";

    const statusClass = `status-${item.status || "unknown"}`;
    card.innerHTML = `
      <div>
        <h3>${item.name}</h3>
        <p>Last issue: ${item.lastIssue || "unknown"}</p>
        <p>Last action: ${item.lastAction || "none"}</p>
      </div>
      <span class="status-badge ${statusClass}">${item.status || "unknown"}</span>
    `;

    deploymentsEl.appendChild(card);
  });
}

function renderDecisions(items) {
  decisionsEl.innerHTML = "";

  if (!items.length) {
    decisionsEl.innerHTML = "<p>No audit entries yet.</p>";
    return;
  }

  items.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <span>${formatTimestamp(entry.timestamp)}</span>
      <span>${entry.deployment}</span>
      <span>${entry.issue}</span>
      <span>${entry.action}</span>
      <span>${entry.approvedBy ? `@${entry.approvedBy}` : "-"}</span>
    `;

    decisionsEl.appendChild(row);
  });
}

function renderCounts(counts) {
  restartsEl.textContent = counts.restartsToday;
  scalesEl.textContent = counts.scalesToday;
  alertsEl.textContent = counts.alertsToday;
}

function renderLogs(lines, error) {
  if (error) {
    logStatusEl.textContent = `Log fetch error: ${error}`;
  } else {
    logStatusEl.textContent = "";
  }

  if (!lines.length) {
    logTailEl.textContent = "No logs available yet.";
    return;
  }

  logTailEl.textContent = lines.join("\n");
}

async function fetchStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Status ${response.status}`);
    }

    const data = await response.json();
    renderDeployments(data.deployments || []);
    renderDecisions(data.recentDecisions || []);
    renderCounts(data.counts || { restartsToday: 0, scalesToday: 0, alertsToday: 0 });
    renderLogs(data.logTail || [], data.logError);

    const updatedAt = new Date(data.updatedAt);
    lastUpdatedEl.textContent = `Updated ${updatedAt.toLocaleTimeString()}`;
  } catch (error) {
    lastUpdatedEl.textContent = "Update failed";
    logStatusEl.textContent = error.message;
  }
}

fetchStatus();
setInterval(fetchStatus, POLL_INTERVAL_MS);
