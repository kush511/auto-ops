/**
 * Slack Callback Server - Handles interactive button clicks and Slack events
 * Runs on port 3001 to handle Slack action requests
 *
 * Key features:
 * - Signature verification for Slack requests
 * - Approve/Reject button handlers
 * - Event-driven execution (immediate on button click)
 * - 3-second ack requirement for Slack
 */

const express = require('express');
const crypto = require('crypto');

class SlackCallbackServer {
  constructor(approvalManager, actionExecutor, slackAlert, port = 3001) {
    this.approvalManager = approvalManager;
    this.actionExecutor = actionExecutor;
    this.slackAlert = slackAlert;
    this.port = port;
    this.app = express();

    // CORRECT: Capture raw body DURING parsing, not after
    // Use verify callback in express.urlencoded - this is called at the right moment
    this.app.use(express.urlencoded({
      extended: true,
      verify: (req, res, buf, encoding) => {
        req.rawBody = buf.toString(encoding || 'utf8');
      }
    }));

    // Also parse JSON requests
    this.app.use(express.json());

    this.app.get('/health', (req, res) => res.json({ status: 'ok' }));
    this.app.post('/slack/actions', (req, res) => this.handleSlackAction(req, res));
  }

  /**
   * Verify Slack request signature
   * Prevents replay attacks and ensures request authenticity
   */
  verifySlackSignature(req) {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      console.warn('⚠️ SLACK_SIGNING_SECRET not set, skipping signature verification');
      return true;  // Skip if not configured
    }

    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    // Verify timestamp is within 5 minutes (prevent replay attacks)
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
      console.error('❌ Request timestamp too old, potential replay attack');
      return false;
    }

    // Verify signature
    const baseString = `v0:${timestamp}:${req.rawBody}`;
    const hash = crypto.createHmac('sha256', signingSecret)
      .update(baseString, 'utf8')
      .digest('hex');
    const expectedSignature = `v0=${hash}`;

    // Debug logging
    if (signature !== expectedSignature) {
      console.error('❌ Invalid Slack signature');
      console.error(`   Expected: ${expectedSignature}`);
      console.error(`   Got:      ${signature}`);
      console.error(`   Raw body length: ${req.rawBody ? req.rawBody.length : 'undefined'}`);
      console.error(`   Timestamp: ${timestamp}`);
      return false;
    }

    console.log(`✅ Slack signature verified`);
    return true;
  }

  /**
   * Handle Slack interactive actions (button clicks)
   */
  async handleSlackAction(req, res) {
    console.log(`📨 Received Slack callback`);
    console.log(`   Headers: x-slack-request-timestamp=${req.headers['x-slack-request-timestamp']}`);
    console.log(`   Raw body exists: ${!!req.rawBody}`);
    console.log(`   Raw body length: ${req.rawBody ? req.rawBody.length : 'undefined'}`);
    console.log(`   Body content keys: ${req.body ? Object.keys(req.body).join(', ') : 'no body'}`);

    // Verify Slack request
    if (!this.verifySlackSignature(req)) {
      return res.status(401).json({ error: 'Invalid request signature' });
    }

    // Parse the payload from Slack
    let payload;
    try {
      payload = JSON.parse(req.body.payload || '{}');
    } catch (parseError) {
      console.error(`❌ Failed to parse Slack payload: ${parseError.message}`);
      return res.status(400).json({ error: 'Invalid payload JSON' });
    }
    const { actions, user, trigger_id } = payload;

    if (!actions || actions.length === 0) {
      return res.status(400).json({ error: 'No actions in payload' });
    }

    // Acknowledge to Slack immediately (3 second requirement)
    res.status(200).json({ ok: true });

    // Process action asynchronously
    setImmediate(async () => {
      await this.processAction(actions[0], user, trigger_id, payload);
    });
  }

  /**
   * Process a Slack action (approve or reject)
   */
  async processAction(action, user, triggerId, fullPayload) {
    const actionId = action.action_id;
    const approvalId = action.value;
    const userId = user?.id || 'unknown';

    console.log(`📨 Slack action received: ${actionId} for approval ${approvalId} by ${userId}`);

    try {
      if (actionId === 'approve_action') {
        await this.handleApproveAction(approvalId, userId, fullPayload);
      } else if (actionId === 'reject_action') {
        await this.handleRejectAction(approvalId, userId, fullPayload);
      } else {
        console.warn(`⚠️ Unknown action: ${actionId}`);
      }
    } catch (error) {
      console.error(`❌ Error processing action: ${error.message}`);
      await this.notifyError(error.message);
    }
  }

  /**
   * Handle approve action - Execute the action immediately
   */
  async handleApproveAction(approvalId, userId, fullPayload) {
    console.log(`✅ Processing approval: ${approvalId}`);

    // Get the approval request
    const approval = this.approvalManager.getApprovalRequest(approvalId);
    if (!approval) {
      console.error(`❌ Approval not found: ${approvalId}`);
      await this.notifyError(`Approval not found: ${approvalId}`);
      return;
    }

    if (approval.status === 'expired') {
      console.warn(`⚠️ Approval expired: ${approvalId}`);
      await this.notifyError(`Approval expired, action was not executed`);
      return;
    }

    if (approval.status !== 'pending') {
      console.warn(`⚠️ Approval already ${approval.status}: ${approvalId}`);
      await this.notifyError(`Approval already ${approval.status}`);
      return;
    }

    // Mark as approved in approval manager
    await this.approvalManager.approveAction(approvalId, userId);

    // Execute the action immediately
    console.log(`🚀 Executing approved action: ${approval.action} on ${approval.deployment}`);
    try {
      // Add skipApprovalCheck=true to bypass approval check (already approved!)
      const actionParams = {
        ...approval.actionParams,
        skipApprovalCheck: true
      };

      const result = await this.actionExecutor.execute(
        approval.action,
        actionParams
      );

      if (result.success) {
        console.log(`✅ Action executed successfully: ${approval.action}`);
        await this.approvalManager.markExecuted(approvalId, result);

        // Send confirmation to Slack
        if (this.slackAlert) {
          await this.slackAlert.send({
            issueType: 'approval_executed',
            deployment: approval.deployment,
            issue: `Approved action executed: ${approval.action}`,
            severity: 'info',
            confidence: approval.confidence,
            action: approval.action,
            reasoning: `Action approved and executed by <@${userId}> | approval_id=${approvalId}`
          });
        }
      } else {
        console.error(`❌ Action execution failed: ${result.error}`);
        await this.notifyError(`Action execution failed: ${result.error}`);
      }
    } catch (error) {
      console.error(`❌ Exception during action execution: ${error.message}`);
      await this.notifyError(`Exception during action execution: ${error.message}`);
    }
  }

  /**
   * Handle reject action
   */
  async handleRejectAction(approvalId, userId, fullPayload) {
    console.log(`❌ Processing rejection: ${approvalId}`);

    // Get the approval request
    const approval = this.approvalManager.getApprovalRequest(approvalId);
    if (!approval) {
      console.error(`❌ Approval not found: ${approvalId}`);
      await this.notifyError(`Approval not found: ${approvalId}`);
      return;
    }

    if (approval.status !== 'pending') {
      console.warn(`⚠️ Approval already ${approval.status}: ${approvalId}`);
      await this.notifyError(`Approval already ${approval.status}`);
      return;
    }

    // Mark as rejected in approval manager
    const reason = 'User rejected via Slack';
    await this.approvalManager.rejectAction(approvalId, userId, reason);

    // Send notification to Slack
    if (this.slackAlert) {
      await this.slackAlert.send({
        issueType: 'approval_rejected',
        deployment: approval.deployment,
        issue: `Action rejected: ${approval.action}`,
        severity: 'info',
        confidence: approval.confidence,
        action: 'log_only',
        reasoning: `Action rejected by <@${userId}> | approval_id=${approvalId}`
      });
    }

    console.log(`✅ Approval rejected: ${approvalId}`);
  }

  /**
   * Send error notification to Slack
   */
  async notifyError(message) {
    if (this.slackAlert) {
      try {
        await this.slackAlert.send({
          issueType: 'approval_error',
          deployment: 'system',
          issue: 'Error processing approval',
          severity: 'high',
          confidence: 1.0,
          action: 'log_only',
          reasoning: message
        });
      } catch (error) {
        console.error(`❌ Failed to send error notification: ${error.message}`);
      }
    }
  }

  /**
   * Start the callback server
   */
  start() {
    this.server = this.app.listen(this.port, () => {
      console.log(`🚀 Slack callback server listening on port ${this.port}`);
      console.log(`📍 Slack will send actions to: POST /slack/actions`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down callback server gracefully...');
      this.server.close();
    });
  }

  /**
   * Get server health status
   */
  getHealth() {
    return {
      running: this.server?.listening || false,
      port: this.port,
      approvalStats: this.approvalManager.getStats()
    };
  }
}

module.exports = SlackCallbackServer;
