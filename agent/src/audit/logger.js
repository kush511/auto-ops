const fs = require('fs').promises;
const path = require('path');

/**
 * AuditLogger - Records every decision the agent makes
 * This creates an immutable trail of actions for debugging and demos
 */
class AuditLogger {
  constructor(logPath = '/agent/audit/actions.jsonl') {
    this.logPath = logPath;
    this.initialize();
  }

  /**
   * Ensure the log directory exists
   * Called once when agent starts
   */
  async initialize() {
    try {
      const dir = path.dirname(this.logPath);
      await fs.mkdir(dir, { recursive: true });
      console.log(` Audit logger initialized at ${this.logPath}`);
    } catch (error) {
      console.error(' Failed to initialize audit logger:', error.message);
    }
  }

  /**
   * Record a decision
   * @param {Object} data - Decision data (issue, action, reasoning, etc.)
   * @returns {Object} The logged entry with timestamp and ID
   */
  async log(data) {
    const entry = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      ...data
    };

    try {
      // Append as JSON line (JSONL format - one JSON object per line)
      await fs.appendFile(this.logPath, JSON.stringify(entry) + '\n');
      console.log(` Audit entry written: ${entry.id}`);
      return entry;
    } catch (error) {
      console.error(' Failed to write audit entry:', error.message);
      return null;
    }
  }

  /**
   * Get recent logs for viewing
   * @param {number} limit - Number of entries to return
   * @returns {Array} Most recent audit entries
   */
  async getRecent(limit = 100) {
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      const lines = content.trim().split('\n');
      const logs = lines.slice(-limit).map(line => JSON.parse(line));
      return logs.reverse(); // Most recent first
    } catch (error) {
      console.error('❌ Failed to read audit log:', error.message);
      return [];
    }
  }

  /**
   * Generate unique ID for audit entry
   * Format: audit-[timestamp]-[random]
   */
  generateId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `audit-${timestamp}-${random}`;
  }
}

module.exports = AuditLogger;