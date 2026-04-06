const fs = require("fs");
const path = require("path");

const logFilePath = path.join(__dirname, "../../logs/app.log");
const logDirPath = path.dirname(logFilePath);

function ensureLogDirectory() {
  if (!fs.existsSync(logDirPath)) {
    fs.mkdirSync(logDirPath, { recursive: true });
  }
}

ensureLogDirectory();

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
  try {
    fs.appendFileSync(logFilePath, logLine);
  } catch (error) {
    console.error(`Failed to write log file at ${logFilePath}: ${error.message}`);
  }

  console.log(logLine);
}

module.exports = {
  info: (msg, meta) => log("INFO", msg, meta),
  warn: (msg, meta) => log("WARN", msg, meta),
  error: (msg, meta) => log("ERROR", msg, meta),
};