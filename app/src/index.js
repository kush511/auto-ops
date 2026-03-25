const express = require("express");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  logger.info("Incoming request", {
    method: req.method,
    url: req.url
  });
  next();
});
// Health check
app.get("/health", (req, res) => {
  logger.info("Health check called");
  res.json({ status: "ok" });
});

// Simulate error
app.get("/simulate-error", (req, res) => {
  logger.error("Simulated database failure", {
    errorCode: "DB_TIMEOUT"
  });
  res.status(500).json({ error: "Simulated failure" });
});

// Simulate latency
app.get("/simulate-latency", async (req, res) => {
  const delay = Math.floor(Math.random() * 3000);

  await new Promise((resolve) => setTimeout(resolve, delay));

  if (delay > 2000) {
    logger.warn("High response latency detected", { delay });
  }

  res.json({ delay });
});

app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});