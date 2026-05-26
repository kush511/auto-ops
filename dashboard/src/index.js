const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const util = require("util");
const { exec } = require("child_process");

const execPromise = util.promisify(exec);

const PORT = parseInt(process.env.PORT, 10) || 8080;
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || "/dashboard/audit/actions.jsonl";
const APPROVAL_LOG_PATH = process.env.APPROVAL_LOG_PATH || "/dashboard/audit/approvals.jsonl";
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || "default";
const DEPLOYMENTS = (process.env.DEPLOYMENTS || "app-deployment")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const APP_LOG_DEPLOYMENT = process.env.APP_LOG_DEPLOYMENT || DEPLOYMENTS[0] || "app-deployment";

const app = express();
const staticDir = path.join(__dirname, "..", "public");

app.use(express.static(staticDir));

function normalizeAction(action) {
  const normalized = String(action || "").toLowerCase();
  const mapping = {
    restart_service: "restart",
    scale_service: "scale",
    scale_down_service: "scaledown",
    rollback_service: "rollback"
  };

  return mapping[normalized] || normalized;
}

function isRestartAction(action) {
  const normalized = normalizeAction(action);
  return normalized.includes("restart");
}

function isScaleAction(action) {
  const normalized = normalizeAction(action);
  return normalized.includes("scale") && !normalized.includes("scaledown");
}

function isRollbackAction(action) {
  const normalized = normalizeAction(action);
  return normalized.includes("rollback");
}

function isApprovalRequiredAction(action) {
  const normalized = normalizeAction(action);
  return normalized.includes("scaledown") || normalized.includes("rollback");
}

function isNoopAction(action) {
  const normalized = normalizeAction(action);
  return normalized === "log_only" || normalized === "suppressed_duplicate_action";
}

function classifyStatus(action) {
  if (!action) return "unknown";
  if (isRestartAction(action)) return "restarting";
  if (isScaleAction(action) || isRollbackAction(action)) return "degraded";
  if (isNoopAction(action)) return "healthy";
  return "degraded";
}

async function readAuditEntries() {
  try {
    const content = await fs.readFile(AUDIT_LOG_PATH, "utf8");
    if (!content.trim()) return [];
    return content
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    console.error("Failed to read audit log:", error.message);
    return [];
  }
}

async function readApprovalEntries() {
  try {
    const content = await fs.readFile(APPROVAL_LOG_PATH, "utf8");
    if (!content.trim()) return [];
    return content
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    console.error("Failed to read approval log:", error.message);
    return [];
  }
}

function buildApprovalIndex(entries) {
  const approvals = entries
    .filter((entry) => entry.status === "approved" || entry.status === "executed")
    .filter((entry) => entry.deployment && entry.action)
    .map((entry) => ({
      deployment: entry.deployment,
      action: normalizeAction(entry.action),
      status: entry.status,
      respondedBy: entry.respondedBy || null,
      respondedAt: entry.respondedAt || entry.createdAt || null
    }))
    .filter((entry) => entry.respondedAt && entry.respondedBy);

  const byKey = new Map();
  approvals.forEach((entry) => {
    const key = `${entry.deployment}:${entry.action}`;
    if (!byKey.has(key)) {
      byKey.set(key, []);
    }
    byKey.get(key).push(entry);
  });

  for (const list of byKey.values()) {
    list.sort((a, b) => new Date(b.respondedAt) - new Date(a.respondedAt));
  }

  return byKey;
}

function attachApprovers(decisions, approvalIndex) {
  const matchWindowMs = 30 * 60 * 1000;

  return decisions.map((decision) => {
    if (!isApprovalRequiredAction(decision.action)) {
      return { ...decision, approvedBy: null };
    }
    const key = `${decision.deployment}:${normalizeAction(decision.action)}`;
    const candidates = approvalIndex.get(key) || [];
    const decisionTime = new Date(decision.timestamp || 0).getTime();
    let approvedBy = null;

    for (const candidate of candidates) {
      const candidateTime = new Date(candidate.respondedAt).getTime();
      if (candidateTime >= decisionTime && candidateTime - decisionTime <= matchWindowMs) {
        approvedBy = candidate.respondedBy;
        break;
      }
    }

    return {
      ...decision,
      approvedBy
    };
  });
}

function getRecentDecisions(entries, limit = 10) {
  return entries
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit)
    .map((entry) => ({
      timestamp: entry.timestamp,
      deployment: entry.deployment || "unknown",
      issue: entry.issue || "unknown",
      action: entry.action || "log_only",
      actionSuccess: entry.action_success === true
    }));
}

function getCounts(entries) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let restartsToday = 0;
  let scalesToday = 0;
  let alertsToday = 0;

  entries.forEach((entry) => {
    const entryTime = new Date(entry.timestamp || 0);
    if (entryTime < startOfDay) return;

    const action = entry.action || "";

    if (isRestartAction(action)) {
      restartsToday += 1;
      alertsToday += 1;
      return;
    }

    if (isScaleAction(action)) {
      scalesToday += 1;
      alertsToday += 1;
      return;
    }

    if (isRollbackAction(action)) {
      alertsToday += 1;
    }
  });

  return {
    restartsToday,
    scalesToday,
    alertsToday
  };
}

function getDeploymentStatuses(entries) {
  const sorted = entries
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return DEPLOYMENTS.map((deployment) => {
    const entry = sorted.find((item) => item.deployment === deployment);
    const action = entry?.action || null;

    return {
      name: deployment,
      status: classifyStatus(action),
      lastAction: action || "none",
      lastIssue: entry?.issue || "unknown",
      lastTimestamp: entry?.timestamp || null
    };
  });
}

async function getLogTail() {
  const command = `kubectl logs deployment/${APP_LOG_DEPLOYMENT} -n ${K8S_NAMESPACE} --tail=20`;
  try {
    const { stdout } = await execPromise(command, {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    const lines = stdout.trim().split("\n").filter(Boolean);
    return { lines };
  } catch (error) {
    return { lines: [], error: error.message };
  }
}

app.get("/api/status", async (req, res) => {
  const entries = await readAuditEntries();
  const approvals = await readApprovalEntries();
  const approvalIndex = buildApprovalIndex(approvals);
  const recentDecisions = attachApprovers(
    getRecentDecisions(entries, 10),
    approvalIndex
  );
  const counts = getCounts(entries);
  const deployments = getDeploymentStatuses(entries);
  const logTail = await getLogTail();

  res.json({
    updatedAt: new Date().toISOString(),
    deployments,
    recentDecisions,
    counts,
    logTail: logTail.lines,
    logError: logTail.error || null
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard listening on port ${PORT}`);
  console.log(`Audit log path: ${AUDIT_LOG_PATH}`);
  console.log(`Approval log path: ${APPROVAL_LOG_PATH}`);
  console.log(`Watching deployments: ${DEPLOYMENTS.join(", ")}`);
});
