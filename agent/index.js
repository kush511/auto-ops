const fs = require("fs")
const path = require("path")
const analyzeLogs = require("./ai");
const logFile = process.env.LOG_PATH || "/agent/logs/app.log"; 
let logBuffer = [];
let errorCount = 0;
let warnCount = 0;

function processLog(line) {
  logBuffer.push(line);

  if (logBuffer.length >= 5) {
    const logs = logBuffer.join("\n");

    analyzeLogs(logs).then((result) => {
      console.log(" AI Decision:\n", result);
    });

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
      stream.on("end", () => {
        const lines = data.trim().split("\n");
        lines.forEach(processLog);
      });

      lastSize = stats.size;
    }
  }, 2000);
}

console.log("Agent started...");
watchLogs();