const fs = require("fs");
const path = require("path");

const logFilePath = path.join(__dirname, "../../logs/app.log");

function log(level, message, meta = {}) {
  const logEntry = {
    level,
    message,
    service: "backend",
    timestamp: new Date().toISOString(),
    ...meta
  };

  const logLine = JSON.stringify(logEntry) + "\n";

  // Write to file
  fs.appendFileSync(logFilePath, logLine);

  console.log(logLine);
}

module.exports = {
  info: (msg, meta) => log("INFO", msg, meta),
  warn: (msg, meta) => log("WARN", msg, meta),
  error: (msg, meta) => log("ERROR", msg, meta),
};