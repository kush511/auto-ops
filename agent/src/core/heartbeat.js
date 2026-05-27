const fs = require('fs').promises;
const path = require('path');

/**
 * HeartbeatWriter writes a timestamp to a shared file every 60 seconds.
 * This file is monitored by the watchdog sidecar to detect if the agent has crashed.
 * The file is stored on a shared emptyDir volume so both agent and sidecar can access it.
 */
class HeartbeatWriter {
  constructor(heartbeatPath = '/agent/heartbeat/timestamp.txt') {
    this.heartbeatPath = heartbeatPath;
    this.heartbeatIntervalId = null;
  }

  /**
   * Initialize the heartbeat directory.
   * Called once at agent startup to ensure the directory exists.
   */
  async initialize() {
    try {
      const dir = path.dirname(this.heartbeatPath);
      await fs.mkdir(dir, { recursive: true });
      console.log(`✓ Heartbeat writer initialized at ${this.heartbeatPath}`);
      return true;
    } catch (error) {
      console.error(`✗ Failed to initialize heartbeat: ${error.message}`);
      return false;
    }
  }

  /**
   * Write current timestamp to the heartbeat file.
   * This signals to the watchdog that the agent is alive.
   *
   * @private
   */
  async write() {
    try {
      const timestamp = Date.now().toString();
      await fs.writeFile(this.heartbeatPath, timestamp, 'utf8');
      console.log(`Heartbeat written: ${new Date().toISOString()}`);
    } catch (error) {
      console.error(`✗ Failed to write heartbeat: ${error.message}`);
      // Don't throw - allow agent to continue even if heartbeat fails
    }
  }

  /**
   * Start writing heartbeat at regular intervals.
   * Writes immediately, then every intervalMs milliseconds.
   *
   * @param {number} intervalMs - Interval between heartbeat writes (default 60000 = 60 seconds)
   */
  startHeartbeat(intervalMs = 60000) {
    if (this.heartbeatIntervalId) {
      console.warn('Heartbeat is already running');
      return;
    }

    console.log(
      `Starting agent heartbeat with ${intervalMs}ms interval ` +
      `(${(intervalMs / 1000).toFixed(0)}s)`
    );

    // Write immediately
    this.write();

    // Then write at regular intervals
    this.heartbeatIntervalId = setInterval(() => this.write(), intervalMs);
  }

  /**
   * Stop writing heartbeat.
   * Called when the agent is shutting down or entering maintenance mode.
   */
  stopHeartbeat() {
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
      console.log('Heartbeat stopped');
    }
  }

  /**
   * Get the current heartbeat status for debugging.
   */
  async getStatus() {
    try {
      const timestamp = await fs.readFile(this.heartbeatPath, 'utf8');
      const fileTime = parseInt(timestamp);
      const now = Date.now();
      const ageMs = now - fileTime;

      return {
        path: this.heartbeatPath,
        lastHeartbeatMs: fileTime,
        ageMs: ageMs,
        ageSeconds: (ageMs / 1000).toFixed(1),
        isActive: this.heartbeatIntervalId !== null
      };
    } catch (error) {
      return {
        path: this.heartbeatPath,
        error: error.message,
        isActive: this.heartbeatIntervalId !== null
      };
    }
  }
}

module.exports = HeartbeatWriter;
