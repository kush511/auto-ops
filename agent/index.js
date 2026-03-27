const fs = require("fs")
const path = require("path")
const analyzeLogs = require("./ai");
const decideAction = require("./decision");
const actions = require("./actions");
const logFile = process.env.LOG_PATH || "/agent/logs/app.log"; 
let logBuffer = [];
let errorCount = 0;
let warnCount = 0;
let lastActionTime = 0;

function canAct() {
  const now = Date.now();
  if (now - lastActionTime < 10000) return false;
  lastActionTime = now;
  return true;
}

async function processLog(line) {
  logBuffer.push(line);

  if (logBuffer.length >= 5) {
    const logs = logBuffer.join("\n");

    try {
      const aiResult = await analyzeLogs(logs);

      if (!aiResult) return;

      const decision = decideAction(aiResult);

      console.log(" Decision:", decision);

      if (decision.action === "restart_service") {
        if (canAct()) {
          actions.restartService();
        }
      }

      if (decision.action === "scale_service") {
        if (canAct()) {
          actions.scaleService();
        }
      }
    } catch (err) {
      console.log("AI analysis failed:", err.message);
    }
    
    logBuffer = [];
  }
}

function watchLogs() {
  let lastSize = 0;

  setInterval(() => {
    if (!fs.existsSync(logFile)) return;

    const stats = fs.statSync(logFile);

    if (stats.size > lastSize) {
      const stream = fs.createReadStream(logFile, {
        start: lastSize,
        end: stats.size
      });

      let data = "";

      stream.on("data", chunk => data += chunk);
      stream.on("end", async () => {
        const lines = data.trim().split("\n");
        for (const line of lines) {
          await processLog(line);
        }
      });

      lastSize = stats.size;
    }
  }, 2000);
}

console.log("Agent started...");
watchLogs();