const util = require('util');
const { exec } = require('child_process');
const execPromise = util.promisify(exec);

/**
 * LogStreamManager handles kubectl logs collection with exponential backoff retry
 * on failures. This is crucial for gracefully handling pod restarts which can
 * take 10-15 seconds for kubectl logs to reconnect.
 */
class LogStreamManager {
  constructor(deploymentName, namespace = 'default') {
    this.deploymentName = deploymentName;
    this.namespace = namespace;

    // Backoff configuration
    this.backoffMs = 5000;        // Start at 5 seconds
    this.maxBackoffMs = 60000;    // Max 60 seconds
    this.backoffMultiplier = 2;
    this.currentBackoffMs = this.backoffMs;

    // State tracking
    this.consecutiveFailures = 0;
  }

  /**
   * Collect logs with exponential backoff on failure.
   * Returns logs on success, waits and retries on failure.
   */
  async collectLogsWithBackoff() {
    while (true) {
      try {
        const logs = await this.collectLogsInternal();

        // Success - reset backoff
        if (logs !== null) {
          if (this.consecutiveFailures > 0) {
            console.log(
              `✓ Log stream reconnected after ${this.consecutiveFailures} ` +
              `attempt(s), backoff level was ${this.getCurrentBackoffLevel()}`
            );
            this.consecutiveFailures = 0;
            this.currentBackoffMs = this.backoffMs;
          }
          return logs;
        }

      } catch (error) {
        this.consecutiveFailures++;
        console.warn(
          `✗ Log collection failed (attempt ${this.consecutiveFailures}): ` +
          `${error.message}`
        );
      }

      // Apply exponential backoff before retry
      const backoffLevel = Math.log2(this.currentBackoffMs / this.backoffMs);
      console.log(
        `↻ Backing off for ${this.currentBackoffMs}ms before retry ` +
        `(backoff level ${backoffLevel})`
      );
      await new Promise(resolve => setTimeout(resolve, this.currentBackoffMs));

      // Increase backoff for next attempt
      this.currentBackoffMs = Math.min(
        this.currentBackoffMs * this.backoffMultiplier,
        this.maxBackoffMs
      );
    }
  }

  /**
   * Internal log collection - executes kubectl logs with timeout.
   * Timeout is set to 15-20 seconds to allow for pod restart connection delays.
   * kubectl logs on a restarting pod can take 10-15 seconds to connect.
   */
  async collectLogsInternal() {
    try {
      const command =
        `kubectl logs deployment/${this.deploymentName} -n ${this.namespace} --tail=50 2>/dev/null || echo "No logs found"`;

      const { stdout } = await execPromise(command, {
        timeout: 20000  // 20 second timeout for connection + collection
      });

      return stdout.split('\n').filter((line) => line.trim());
    } catch (error) {
      // Check if it's a timeout (kubectl logs taking too long to connect)
      if (error.code === null && error.killed) {
        throw new Error('kubectl logs timeout - pod may be restarting or connection delayed');
      }

      // Check if it's a real error vs. just kubectl timing out on a new pod
      if (error.signal === 'SIGTERM') {
        throw new Error('kubectl logs command terminated - likely timeout due to pod restart');
      }

      throw error;
    }
  }

  /**
   * Get current backoff level (0 = initial, 1 = 10s, 2 = 20s, etc.)
   */
  getCurrentBackoffLevel() {
    if (this.currentBackoffMs <= this.backoffMs) return 0;
    return Math.log2(this.currentBackoffMs / this.backoffMs);
  }

  /**
   * Reset backoff to initial state
   */
  resetBackoff() {
    const prevBackoffMs = this.currentBackoffMs;
    this.consecutiveFailures = 0;
    this.currentBackoffMs = this.backoffMs;

    if (prevBackoffMs !== this.backoffMs) {
      console.log(
        `↺ Resetting backoff (was at level ${this.getCurrentBackoffLevel()})`
      );
    }
  }

  /**
   * Get current state for logging/debugging
   */
  getState() {
    return {
      deploymentName: this.deploymentName,
      namespace: this.namespace,
      consecutiveFailures: this.consecutiveFailures,
      currentBackoffMs: this.currentBackoffMs,
      backoffLevel: this.getCurrentBackoffLevel(),
      maxBackoffMs: this.maxBackoffMs
    };
  }
}

module.exports = LogStreamManager;
