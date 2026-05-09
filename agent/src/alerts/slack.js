/**
 * SlackAlert - Sends notifications to Slack webhook
 * Features:
 * - Rate limiting to prevent alert storms
 * - Color-coded severity levels
 * - Structured message formatting
 */

class SlackAlert {
  constructor(webhookUrl, options = {}) {
    this.webhookUrl = webhookUrl;
    this.maxAlertsPerHour = options.maxAlertsPerHour || 10;
    this.rateLimits = new Map(); // Stores { count, firstAlertTime }
  }

  /**
   * Check if we should rate limit this type of alert
   * @param {string} issueType - Unique identifier for the issue type
   * @returns {boolean} True if alert should be suppressed
   */
  shouldRateLimit(issueType) {
    const now = Date.now();
    const limitData = this.rateLimits.get(issueType);
    
    if (!limitData) {
      // First alert of this type
      this.rateLimits.set(issueType, {
        count: 1,
        firstAlertTime: now
      });
      return false;
    }
    
    // Check if we're still within the hour window
    const hourInMs = 60 * 60 * 1000;
    const timeSinceFirst = now - limitData.firstAlertTime;
    
    if (timeSinceFirst > hourInMs) {
      // Reset after an hour
      this.rateLimits.set(issueType, {
        count: 1,
        firstAlertTime: now
      });
      return false;
    }
    
    // Check if we've exceeded limit
    if (limitData.count >= this.maxAlertsPerHour) {
      console.log(` Rate limit exceeded for ${issueType} - suppressing alert`);
      return true;
    }
    
    // Increment counter
    limitData.count++;
    this.rateLimits.set(issueType, limitData);
    return false;
  }

  /**
   * Send alert to Slack
   * @param {Object} alertData - The alert payload
   * @returns {Promise<Object>} Result of the send attempt
   */
  async send(alertData) {
    const { issueType, issue, severity, confidence, action, reasoning, deployment } = alertData;
    const normalizedSeverity = severity || 'low';
    const normalizedConfidence = typeof confidence === 'number' ? confidence : 0;
    const normalizedIssue = issue || 'Unknown issue';
    const normalizedAction = action || 'none';
    const normalizedReasoning = reasoning || 'No reasoning provided';
    
    // Rate limiting check
    if (this.shouldRateLimit(issueType)) {
      return { sent: false, reason: 'rate_limited' };
    }
    
    // Format message for Slack
    const color = this.getColor(normalizedSeverity);
    const emoji = this.getEmoji(normalizedSeverity);
    
    const payload = {
      text: `${emoji} *Alert: ${deployment || 'Unknown Deployment'}*`,
      attachments: [{
        color: color,
        title: `🚨 ${normalizedIssue}`,
        fields: [
          {
            name: "Severity",
            value: normalizedSeverity.toUpperCase(),
            inline: true
          },
          {
            name: "Confidence",
            value: `${(normalizedConfidence * 100).toFixed(1)}%`,
            inline: true
          },
          {
            name: "Action Taken",
            value: normalizedAction,
            inline: false
          },
          {
            name: "Reasoning",
            value: normalizedReasoning,
            inline: false
          },
          {
            name: "Time",
            value: new Date().toISOString(),
            inline: true
          }
        ],
        footer: "Auto-Ops Agent",
        ts: Math.floor(Date.now() / 1000)
      }]
    };
    
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        console.log(` Slack alert sent: ${issueType}`);
        return { sent: true };
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.error(' Failed to send Slack alert:', error.message);
      return { sent: false, error: error.message };
    }
  }
  
  /**
   * Get color based on severity (for Slack attachment)
   */
  getColor(severity) {
    const colors = {
      'critical': '#ff0000',
      'high': '#ff6600',
      'medium': '#ffcc00',
      'low': '#00ff00'
    };
    return colors[severity] || '#cccccc';
  }
  
  /**
   * Get emoji based on severity
   */
  getEmoji(severity) {
    const emojis = {
      'critical': '🔴',
      'high': '🟠',
      'medium': '🟡',
      'low': '🟢'
    };
    return emojis[severity] || '⚪';
  }

  /**
   * Send approval request to Slack with interactive buttons
   * Uses Block Kit for rich message formatting
   * @param {string} approvalId - The approval request ID (stored in button value)
   * @param {string} action - The action being requested (rollback, scaleDown, etc)
   * @param {string} deployment - The deployment name
   * @param {number} confidence - The confidence score (0-1)
   * @returns {Promise<Object>} Result of the send attempt
   */
  async sendApprovalRequest(approvalId, action, deployment, confidence) {
    const payload = {
      text: `Action approval needed for ${deployment}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '⏳ Action Approval Required',
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Deployment:*\n${deployment}`
            },
            {
              type: 'mrkdwn',
              text: `*Action:*\n${action}`
            },
            {
              type: 'mrkdwn',
              text: `*Confidence:*\n${(confidence * 100).toFixed(1)}%`
            },
            {
              type: 'mrkdwn',
              text: `*Approval ID:*\n\`${approvalId}\``
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '_This action requires your approval before execution. Click Approve to execute immediately or Reject to cancel._'
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Approve',
                emoji: true
              },
              action_id: 'approve_action',  // static action ID
              value: approvalId,            // dynamic approval ID
              style: 'primary'
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Reject',
                emoji: true
              },
              action_id: 'reject_action',   // static action ID
              value: approvalId,            // dynamic approval ID
              style: 'danger'
            }
          ]
        }
      ]
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log(`✅ Approval request sent to Slack: ${approvalId}`);
        return { sent: true, approvalId };
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.error(`❌ Failed to send approval request to Slack: ${error.message}`);
      return { sent: false, error: error.message };
    }
  }
}

module.exports = SlackAlert;