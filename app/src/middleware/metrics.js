const promClient = require('prom-client');

/**
 * Metrics instrumentation middleware for Express.
 * Tracks:
 * - http_requests_total: Total requests by status code and route
 * - http_request_duration_seconds: Request latency histogram
 * - nodejs_heap_used_bytes: Node.js heap memory usage (updated every 10 seconds)
 */
class MetricsMiddleware {
  constructor() {
    // Use the default registry (global)
    this.register = promClient.register;

    // HTTP requests counter
    this.httpRequestsTotal = new promClient.Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests received',
      labelNames: ['method', 'route', 'status'],
      registers: [this.register]
    });

    // HTTP request duration histogram
    this.httpRequestDuration = new promClient.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10],  // 50ms to 10 seconds
      registers: [this.register]
    });

    // Node.js heap memory gauge (updated periodically)
    this.nodeHeapUsed = new promClient.Gauge({
      name: 'nodejs_heap_used_bytes',
      help: 'Node.js heap memory used in bytes',
      registers: [this.register]
    });

    // Process uptime (automatically tracked by prom-client default metrics)
    promClient.collectDefaultMetrics({ register: this.register });

    // Update heap memory gauge every 10 seconds
    this.startHeapMonitoring();
  }

  /**
   * Start periodic heap memory updates
   * @private
   */
  startHeapMonitoring() {
    setInterval(() => {
      const heapUsed = process.memoryUsage().heapUsed;
      this.nodeHeapUsed.set(heapUsed);
    }, 10000);
  }

  /**
   * Express middleware to track request metrics
   */
  middleware() {
    return (req, res, next) => {
      const startTime = Date.now();
      const method = req.method;
      // Sanitize route (remove user-specific parts)
      const route = req.route?.path || req.path || 'unknown';

      // Wrap res.end to capture status code
      const originalEnd = res.end;
      res.end = function (...args) {
        const duration = (Date.now() - startTime) / 1000;
        const status = res.statusCode;

        // Record metrics
        this.httpRequestsTotal.inc({
          method,
          route,
          status
        });

        this.httpRequestDuration.observe(
          { method, route, status },
          duration
        );

        // Call original res.end
        originalEnd.apply(res, args);
      }.bind(this);

      next();
    };
  }

  /**
   * Handler for /metrics endpoint
   * Returns Prometheus-format metrics
   */
  metricsHandler() {
    return async (req, res) => {
      try {
        res.set('Content-Type', this.register.contentType);
        const metrics = await this.register.metrics();
        res.end(metrics);
      } catch (error) {
        console.error('Error generating metrics:', error);
        res.status(500).end('Error generating metrics');
      }
    };
  }

  /**
   * Get current metrics as JSON (for debugging/testing)
   */
  async getMetricsJSON() {
    const metrics = await this.register.metrics();
    return {
      timestamp: new Date().toISOString(),
      metrics: metrics,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime()
    };
  }
}

module.exports = MetricsMiddleware;
