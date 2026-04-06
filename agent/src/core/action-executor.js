/**
 * ActionExecutor - Unified interface for kubectl operations
 * Executes actions: restart, scale, scaleDown, rollback, log_only
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class ActionExecutor {
  constructor(deploymentName, namespace = 'default') {
    this.deploymentName = deploymentName;
    this.namespace = namespace;
  }

  /**
   * Restart the deployment
   */
  async restart() {
    console.log(`🔄 Executing restart on ${this.deploymentName} (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl rollout restart deployment/${this.deploymentName} -n ${this.namespace}`
      );
      console.log(`✅ Restart initiated: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'restart' };
    } catch (error) {
      console.error(`❌ Restart failed: ${error.message}`);
      return { success: false, error: error.message, action: 'restart' };
    }
  }

  /**
   * Scale deployment to specified replicas
   */
  async scale(replicas = 3) {
    console.log(`📈 Scaling ${this.deploymentName} to ${replicas} replicas (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl scale deployment/${this.deploymentName} -n ${this.namespace} --replicas=${replicas}`
      );
      console.log(`✅ Scale completed: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'scale', replicas };
    } catch (error) {
      console.error(`❌ Scale failed: ${error.message}`);
      return { success: false, error: error.message, action: 'scale', replicas };
    }
  }

  /**
   * Scale down deployment (reduce replicas)
   */
  async scaleDown(replicas = 1) {
    console.log(`📉 Scaling down ${this.deploymentName} to ${replicas} replica(s) (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl scale deployment/${this.deploymentName} -n ${this.namespace} --replicas=${replicas}`
      );
      console.log(`✅ Scale down completed: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'scaleDown', replicas };
    } catch (error) {
      console.error(`❌ Scale down failed: ${error.message}`);
      return { success: false, error: error.message, action: 'scaleDown', replicas };
    }
  }

  /**
   * Rollback deployment to previous revision
   */
  async rollback() {
    console.log(`⏪ Rolling back ${this.deploymentName} to previous revision (namespace: ${this.namespace})`);
    try {
      const { stdout } = await execPromise(
        `kubectl rollout undo deployment/${this.deploymentName} -n ${this.namespace}`
      );
      console.log(`✅ Rollback initiated: ${stdout.trim()}`);
      return { success: true, output: stdout.trim(), action: 'rollback' };
    } catch (error) {
      console.error(`❌ Rollback failed: ${error.message}`);
      return { success: false, error: error.message, action: 'rollback' };
    }
  }

  /**
   * Log only - take no action
   */
  async logOnly() {
    console.log(`📝 Logging only, no action taken on ${this.deploymentName}`);
    return { success: true, output: 'Logged only', action: 'log_only' };
  }

  /**
   * Execute action based on type
   * @param {string} action - Action type: restart, scale, scaleDown, rollback, log_only
   * @param {Object} params - Action parameters (e.g., replicas for scale/scaleDown)
   * @returns {Object} Result with success, output/error, and action type
   */
  async execute(action, params = {}) {
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
        console.log(`⚠️ Unknown action: ${action}`);
        return {
          success: false,
          error: `Unknown action: ${action}`,
          action
        };
    }
  }
}

module.exports = ActionExecutor;
