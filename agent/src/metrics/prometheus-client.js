/**
 * PrometheusClient queries the Prometheus HTTP API to retrieve current system metrics.
 * All queries are optional - if Prometheus is unavailable, the agent continues normally
 * (graceful degradation).
 *
 * Queries executed:
 * - CPU utilization (5-minute average)
 * - Memory utilization
 * - HTTP error rate (5xx errors / total requests)
 * - HTTP P95 latency
 * - Node.js heap usage
 */
class PrometheusClient {
  constructor(prometheusUrl = 'http://prometheus-operated.monitoring.svc.cluster.local:9090') {
    this.prometheusUrl = prometheusUrl;
    this.queryTimeout = 5000; // 5 second timeout per query
  }

  /**
   * Query Prometheus for current metrics of a given deployment.
   * Returns an object with all metric values, or null if unavailable.
   *
   * @param {string} deployment - Deployment name to query metrics for
   * @param {string} namespace - Kubernetes namespace (optional, not used in label matching currently)
   * @returns {Promise<object|null>} Metrics object or null on failure
   */
  async queryMetrics(deployment, namespace = 'default') {
    try {
      // All queries use pod label matching for the deployment
      // Pattern: pod=~"deployment-[0-9a-z]+" (Kubernetes naming convention)
      const podPattern = `${deployment.replace(/[^a-z0-9-]/g, '')}-[0-9a-z]+`;

      const queries = {
        // CPU as percentage (5-minute average)
        cpu: `rate(container_cpu_usage_seconds_total{pod=~"${podPattern}"}[5m]) * 100`,

        // Memory as percentage (used / limit)
        memory: `(container_memory_usage_bytes{pod=~"${podPattern}"} / container_spec_memory_limit_bytes{pod=~"${podPattern}"}) * 100`,

        // HTTP error rate (5xx / total)
        errorRate: `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])`,

        // HTTP P95 latency in milliseconds
        p95Latency: `histogram_quantile(0.95, http_request_duration_seconds_bucket) * 1000`,

        // Node.js heap as percentage (used / limit)
        heapUsage: `(nodejs_heap_used_bytes{pod=~"${podPattern}"} / nodejs_heap_size_limit_bytes{pod=~"${podPattern}"}) * 100`
      };

      const results = {};

      for (const [key, query] of Object.entries(queries)) {
        try {
          const value = await this.executeQuery(query);
          results[key] = value;
        } catch (error) {
          console.warn(`  Warning: Failed to query ${key}: ${error.message}`);
          results[key] = 'N/A';
        }
      }

      return results;
    } catch (error) {
      console.warn(`Prometheus metrics unavailable: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute a single Prometheus query.
   * Returns the metric value or throws on error.
   *
   * @private
   */
  async executeQuery(query) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.queryTimeout);

    try {
      const url = new URL(`${this.prometheusUrl}/api/v1/query`);
      url.searchParams.set('query', query);

      const response = await fetch(url.toString(), {
        signal: controller.signal,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from Prometheus`);
      }

      const data = await response.json();

      // Check for Prometheus API errors
      if (data.status === 'error') {
        throw new Error(`Prometheus error: ${data.error}`);
      }

      // Extract the metric value from the response
      const value = data.data?.result?.[0]?.value?.[1];

      if (value === undefined) {
        return 'N/A';  // No data point
      }

      // Convert to number and round
      return parseFloat(value).toFixed(2);
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Query timeout after ${this.queryTimeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Format metrics as a readable string for inclusion in LLM prompts.
   *
   * @param {object} metrics - Metrics object from queryMetrics()
   * @returns {string} Formatted metrics string
   */
  formatMetricsForPrompt(metrics) {
    if (!metrics) {
      return 'Current metrics: Prometheus unavailable';
    }

    // Build a concise metrics summary line
    const parts = [];

    if (metrics.cpu !== 'N/A') {
      parts.push(`CPU ${metrics.cpu}%`);
    }
    if (metrics.memory !== 'N/A') {
      parts.push(`Memory ${metrics.memory}%`);
    }
    if (metrics.errorRate !== 'N/A') {
      const rate = (parseFloat(metrics.errorRate) * 100).toFixed(2);
      parts.push(`Error rate ${rate}%`);
    }
    if (metrics.p95Latency !== 'N/A') {
      parts.push(`P95 latency ${metrics.p95Latency}ms`);
    }
    if (metrics.heapUsage !== 'N/A') {
      parts.push(`Heap ${metrics.heapUsage}%`);
    }

    if (parts.length === 0) {
      return 'Current metrics: No data available';
    }

    return `Current metrics: ${parts.join(', ')}`;
  }

  /**
   * Check if Prometheus is reachable (health check).
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await fetch(
        `${this.prometheusUrl}/-/healthy`,
        { timeout: 3000 }
      );
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

module.exports = PrometheusClient;
