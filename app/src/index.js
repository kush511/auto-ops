const express = require("express");
const logger = require("./utils/logger");
const { router: chaosRoutes, chaosMiddleware } = require("./routes/chaos");
const MetricsMiddleware = require("./middleware/metrics");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize metrics middleware
const metricsMiddleware = new MetricsMiddleware();

app.use(express.json());

// Apply metrics middleware first (before all routes)
app.use(metricsMiddleware.middleware());

// Apply chaos middleware
app.use(chaosMiddleware);

app.use((req, res, next) => {
  logger.info("Incoming request", {
    method: req.method,
    url: req.url
  });
  next();
});

// Prometheus metrics endpoint
app.get("/metrics", metricsMiddleware.metricsHandler());

app.get("/", (req, res) => {
  res.json({ message: "App is running", timestamp: new Date().toISOString() });
});

app.get("/health", (req, res) => {
  logger.info("Health check called");
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Simulate error
app.get("/simulate-error", (req, res) => {
  logger.error("Simulated database failure", {
    errorCode: "DB_TIMEOUT"
  });
  res.status(500).json({ error: "Simulated failure" });
});

// Error handling middleware (must be after routes)
app.use((err, req, res, next) => {
  logger.error("Error", { message: err.message });
  res.status(500).json({
    error: err.message,
    timestamp: new Date().toISOString()
  });
});

// Chaos routes
app.use(chaosRoutes);

app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
  logger.info("Chaos endpoints available at /chaos/errors, /chaos/latency, /chaos/stop");
});