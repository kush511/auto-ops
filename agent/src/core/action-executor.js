/**
 * ActionExecutor - Unified interface for kubectl operations
 * Executes actions: restart, scale, scaleDown, rollback, log_only
 *
 * Actions requiring Slack approval: rollback, scaleDown
 * Actions executed immediately: restart, scale, log_only
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Actions that require Slack approval before execution
const REQUIRES_APPROVAL = ['rollback', 'scaleDown'];

class ActionExecutor {
  constructor(deploymentName, namespace = 'default', approvalManager = null, slackAlert = null) {
    this.deploymentName = deploymentName;
    this.namespace = namespace;
    this.approvalManager = approvalManager;
    this.slackAlert = slackAlert;
  }

  /**
   * Restart the deployment
   */
  async restart() {
    console.log(`Executing restart on ${this.deploymentName} (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl rollout restart deployment/${this.deploymentName} -n ${this.namespace}`
      );
      console.log(`Restart initiated: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'restart' };
    } catch (error) {
      console.error(`Restart failed: ${error.message}`);
      return { success: false, error: error.message, action: 'restart' };
    }
  }

  /**
   * Scale deployment to specified replicas
   */
  async scale(replicas = 3) {
    console.log(`Scaling ${this.deploymentName} to ${replicas} replicas (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl scale deployment/${this.deploymentName} -n ${this.namespace} --replicas=${replicas}`
      );
      console.log(`Scale completed: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'scale', replicas };
    } catch (error) {
      console.error(`Scale failed: ${error.message}`);
      return { success: false, error: error.message, action: 'scale', replicas };
    }
  }

  /**
   * Scale down deployment (reduce replicas)
   */
  async scaleDown(replicas = 1) {
    console.log(`Scaling down ${this.deploymentName} to ${replicas} replica(s) (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl scale deployment/${this.deploymentName} -n ${this.namespace} --replicas=${replicas}`
      );
      console.log(`Scale down completed: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'scaleDown', replicas };
    } catch (error) {
      console.error(`Scale down failed: ${error.message}`);
      return { success: false, error: error.message, action: 'scaleDown', replicas };
    }
  }

  /**
   * Rollback deployment to previous revision
   */
  async rollback() {
    console.log(`Rolling back ${this.deploymentName} to previous revision (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl rollout undo deployment/${this.deploymentName} -n ${this.namespace}`
      );
      console.log(`Rollback initiated: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'rollback' };
    } catch (error) {
      console.error(`Rollback failed: ${error.message}`);
      return { success: false, error: error.message, action: 'rollback' };
    }
  }

  /**
   * Log only - take no action
   */
  async logOnly() {
    console.log(`Logging only, no action taken on ${this.deploymentName}`);
    return { success: true, output: 'Logged only', action: 'log_only' };
  }

  /**
   * Execute action based on type
   * @param {string} action - Action type: restart, scale, scaleDown, rollback, log_only
   * @param {Object} params - Action parameters (e.g., replicas for scale/scaleDown, confidence for approval)
   * @param {boolean} params.skipApprovalCheck - If true, execute immediately (used by approval callback)
   * @returns {Object} Result with success, output/error, and action type
   *
   * If action requires approval and approval manager is configured:
   * - Creates an approval request and sends Slack notification
   * - Returns { queued: true, approvalId } instead of executing
   * - Does NOT execute the action until approved via Slack
   *
   * If skipApprovalCheck is true:
   * - Bypasses approval requirement (used internally by callback server)
   * - Executes the action immediately
   */
  async execute(action, params = {}) {
    // Check if action requires approval (unless bypassed)
    if (!params.skipApprovalCheck && REQUIRES_APPROVAL.includes(action) && this.approvalManager) {
      console.log(`Action requires approval: ${action}`);

      // Create approval request
      const approvalId = await this.approvalManager.createApprovalRequest(
        action,
        this.deploymentName,
        params,
        params.confidence || 0.0
      );

      // Send Slack approval request
      if (this.slackAlert) {
        try {
          await this.slackAlert.sendApprovalRequest(
            approvalId,
            action,
            this.deploymentName,
            params.confidence || 0.0
          );
        } catch (error) {
          console.error(`Failed to send Slack approval request: ${error.message}`);
        }
      } else {
        console.warn('Slack alert not configured, approval request created but not notified');
      }

      // Return queued status instead of executing
      console.log(`Approval request queued: ${approvalId}`);
      return {
        queued: true,
        approvalId,
        action,
        message: `Action queued for approval. Check Slack for approval request.`
      };
    }

    // Execute immediately for actions that don't require approval (or skipApprovalCheck=true)
    switch (action) {
      case 'restart':
        return await this.restart();

      case 'scale':
        return await this.scale(params.replicas || 3);

      case 'scaleDown':
        return await this.scaleDown(params.replicas || 1);

      case 'rollback':
        return await this.rollback();

      case 'log_only':
        return await this.logOnly();

      default:
        console.log(`Unknown action: ${action}`);
        return {
          success: false,
          error: `Unknown action: ${action}`,
          action
        };
    }
  }
}

module.exports = ActionExecutor;
