#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

/**
 * AgentWatchdog monitors the heartbeat file written by the agent.
 * This is the "dead man's switch" that detects if the agent has crashed
 * or hung and alerts via Slack.
 *
 * Key characteristics:
 * - Checks heartbeat file every 30 seconds
 * - If file is >120s stale, fires an alert
 * - Alert deduplication: only alerts once per incident (10-minute cooldown)
 * - Prevents alert storms during persistent agent failures
 */
class AgentWatchdog {
  constructor(
    heartbeatPath = '/agent/heartbeat/timestamp.txt',
    slackWebhook = null
  ) {
    this.heartbeatPath = heartbeatPath;
    this.slackWebhook = slackWebhook;

    // Check every 30 seconds (half the heartbeat interval)
    this.checkIntervalMs = 30000;

    // Alert if heartbeat is >120 seconds old (2x heartbeat interval)
    this.deadThresholdMs = 120000;

    // Alert deduplication: 10 minutes before re-alerting
    this.alertDeduplicationMs = 600000;

    // State tracking
    this.lastAlertedAt = null;  // Timestamp of last alert fired
  }

  /**
   * Check if the agent is healthy based on heartbeat file.
   * Returns { healthy: boolean, timeSinceUpdateMs: number }
   */
  async checkHealthStatus() {
    try {
      const stats = await fs.stat(this.heartbeatPath);
      const fileModTime = stats.mtimeMs;
      const now = Date.now();
      const timeSinceUpdate = now - fileModTime;

      console.log(
        `[${new Date().toISOString()}] Heartbeat check: ` +
        `${(timeSinceUpdate / 1000).toFixed(1)}s since last update`
      );

      // Check if heartbeat is stale
      if (timeSinceUpdate > this.deadThresholdMs) {
        console.error(
          `🔴 ALERT: Agent appears dead! File not updated for ` +
          `${(timeSinceUpdate / 1000).toFixed(1)}s`
        );

        // Check if we should fire an alert (deduplication)
        await this.handleDeadAgentDetection(timeSinceUpdate);

        return { healthy: false, timeSinceUpdate };
      }

      return { healthy: true, timeSinceUpdate };
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.error('🔴 ALERT: Heartbeat file missing!');
        await this.handleDeadAgentDetection(null, 'File missing');
      } else {
        console.error(`Failed to check heartbeat: ${error.message}`);
      }
      return { healthy: false, error: error.message };
    }
  }

  /**
   * Handle a dead agent detection with alert deduplication.
   * Only alert if we haven't alerted in the past 10 minutes.
   */
  async handleDeadAgentDetection(timeSinceUpdateMs, reason = 'No heartbeat') {
    const now = Date.now();

    // Check if we've recently alerted (within 10 minutes)
    if (this.lastAlertedAt && (now - this.lastAlertedAt) < this.alertDeduplicationMs) {
      const minutesSinceLastAlert = ((now - this.lastAlertedAt) / 60000).toFixed(1);
      console.log(
        `ℹ Suppressing alert (already alerted ${minutesSinceLastAlert}m ago)`
      );
      return;
    }

    // Fire the alert
    const message = timeSinceUpdateMs
      ? `Agent watchdog triggered: No heartbeat for ${(timeSinceUpdateMs / 1000).toFixed(1)}s`
      : `Agent watchdog triggered: ${reason}`;

    await this.alertSlack(message);
    this.lastAlertedAt = now;
  }

  /**
   * Send alert to Slack with exponential backoff retry.
   * Max attempts: 5 (with backoff between attempts)
   */
  async alertSlack(message) {
    if (!this.slackWebhook) {
      console.log('ℹ Slack not configured, skipping alert');
      return;
    }

    let backoffMs = 1000;  // Start at 1 second
    const maxBackoffMs = 4000;  // Max 4 seconds
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      try {
        const response = await fetch(this.slackWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: '🔴 Agent Watchdog Alert',
            attachments: [{
              color: '#ff0000',
              title: 'Dead Man Switch Triggered',
              fields: [{
                title: 'Message',
                value: message,
                short: false
              }, {
                title: 'Time',
                value: new Date().toISOString(),
                short: true
              }, {
                title: 'Host',
                value: process.env.HOSTNAME || 'unknown',
                short: true
              }],
              footer: 'Auto-Ops Watchdog',
              ts: Math.floor(Date.now() / 1000)
            }]
          })
        });

        if (response.ok) {
          console.log('✓ Slack alert sent successfully');
          return;
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        attempts++;
        console.warn(
          `✗ Slack alert failed (attempt ${attempts}/${maxAttempts}): ` +
          `${error.message}`
        );

        if (attempts < maxAttempts) {
          console.log(`↻ Retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        }
      }
    }

    console.error('✗ Failed to send Slack alert after all retries');
  }

  /**
   * Get watchdog status for debugging
   */
  getStatus() {
    const now = Date.now();
    const lastAlertAge = this.lastAlertedAt
      ? `${((now - this.lastAlertedAt) / 60000).toFixed(1)}m ago`
      : 'never';

    return {
      heartbeatPath: this.heartbeatPath,
      checkIntervalMs: this.checkIntervalMs,
      deadThresholdMs: this.deadThresholdMs,
      alertDeduplicationMs: this.alertDeduplicationMs,
      lastAlertedAt: lastAlertAge,
      slackConfigured: !!this.slackWebhook
    };
  }

  /**
   * Start the watchdog monitoring loop
   */
  async start() {
    console.log('🛡️  Starting Agent Watchdog...');
    console.log(`📍 Heartbeat path: ${this.heartbeatPath}`);
    console.log(`⏱️  Check interval: ${this.checkIntervalMs}ms`);
    console.log(`⏲️  Dead threshold: ${this.deadThresholdMs}ms`);
    console.log(`🔕 Alert deduplication: ${this.alertDeduplicationMs}ms`);
    console.log(`💬 Slack: ${this.slackWebhook ? 'configured' : 'not configured'}`);
    console.log('');

    // Check immediately
    await this.checkHealthStatus();

    // Then check at regular intervals
    setInterval(() => this.checkHealthStatus(), this.checkIntervalMs);
  }
}

// Main entry point
if (require.main === module) {
  const watchdog = new AgentWatchdog(
    process.env.HEARTBEAT_PATH || '/agent/heartbeat/timestamp.txt',
    process.env.SLACK_WEBHOOK_URL
  );

  watchdog.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Watchdog shutting down gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Watchdog interrupted');
    process.exit(0);
  });
}

module.exports = AgentWatchdog;
