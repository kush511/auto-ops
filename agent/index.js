const { spawn } = require("child_process");
const analyzeLogs = require("./ai");
const decideAction = require("./decision");
const actions = require("./actions");

const DEPLOYMENT   = process.env.APP_DEPLOYMENT  || "app-deployment";
const NAMESPACE    = process.env.K8S_NAMESPACE    || "default";
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE || "5", 10);
const COOLDOWN_MS  = parseInt(process.env.COOLDOWN_MS || "30000", 10);

let logBuffer      = [];
let lastActionTime = 0;

function canAct() {
  const now = Date.now();
  if (now - lastActionTime < COOLDOWN_MS) {
    console.log(`⏳ Cooldown active — ${Math.round((COOLDOWN_MS - (now - lastActionTime)) / 1000)}s remaining`);
    return false;
  }
  lastActionTime = now;
  return true;
}

async function processBatch() {
  const batch = logBuffer.splice(0, BATCH_SIZE);
  console.log(`📥 Analysing batch of ${batch.length} lines`);

  try {
    const aiResult = await analyzeLogs(batch.join("\n"));
    console.log("🧠 AI result:", JSON.stringify(aiResult));

    if (!aiResult) return;

    const decision = decideAction(aiResult);
    console.log("📋 Decision:", JSON.stringify(decision));

    if (decision.action === "restart_service" && canAct()) {
      console.log("⚙️  Executing restart");
      await actions.restartDeployment();
    } else if (decision.action === "scale_service" && canAct()) {
      console.log("⚙️  Executing scale");
      await actions.scaleDeployment();
    } else {
      console.log(`ℹ️  Action: ${decision.action} — no kubectl call needed`);
    }
  } catch (err) {
    console.error("❌ AI analysis failed:", err.message);
  }
}

function startLogStream() {
  const args = [
    "logs",
    `deployment/${DEPLOYMENT}`,
    "-n", NAMESPACE,
    "-f",
    "--tail=0",
    "--timestamps",
  ];

  console.log(`📡 Agent started`);
  console.log(`👀 Streaming: kubectl ${args.join(" ")}`);

  const proc = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });

  let partial = "";

  proc.stdout.on("data", (chunk) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      logBuffer.push(line);
      if (logBuffer.length >= BATCH_SIZE) {
        processBatch();
      }
    }
  });

  proc.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg.includes("waiting for pod") || msg.includes("Waiting")) {
      console.log(`⏳ ${msg}`);
    } else {
      console.error(`❌ kubectl stderr: ${msg}`);
      console.error(`   Check: pods/log RBAC, deployment name, namespace`);
    }
  });

  proc.on("close", (code) => {
    console.warn(`⚠️  kubectl logs exited (code ${code}) — reconnecting in 5s`);
    setTimeout(startLogStream, 5000);
  });

  proc.on("error", (err) => {
    console.error(`❌ Failed to spawn kubectl: ${err.message}`);
    setTimeout(startLogStream, 5000);
  });
}

startLogStream();