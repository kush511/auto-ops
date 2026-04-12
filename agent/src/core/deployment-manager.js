const { spawn } = require('child_process');
const path = require('path');

/**
 * DeploymentManager orchestrates independent child processes,
 * one per deployment to be monitored.
 *
 * Each child process:
 * - Runs in a separate Node.js instance
 * - Has independent memory and CPU
 * - Can be restarted independently
 * - Inherits parent's environment variables with DEPLOYMENT_NAME override
 */
class DeploymentManager {
  constructor(deployments, inheritedEnv = {}) {
   this.deployments = deployments;  // Array of deployment names
    this.inheritedEnv = inheritedEnv;
    this.children = new Map();  // Map<deployment, childProcess>
  }

  /**
   * Start all deployment workers
   */
  startAll() {
    console.log(`🚀 Starting ${this.deployments.length} deployment worker(s)...`);

    for (const deployment of this.deployments) {
      this.startWorker(deployment);
    }

    console.log(`✓ All workers started`);
  }

  /**
   * Start a single deployment worker as a child process
   * @private
   */
  startWorker(deployment) {
    // Avoid starting duplicate workers
    if (this.children.has(deployment)) {
      console.warn(`Worker for ${deployment} is already running`);
      return;
    }

    console.log(`📍 Spawning worker for deployment: ${deployment}`);

    const workerPath = path.join(__dirname, 'deployment-worker.js');

    // Create environment with DEPLOYMENT_NAME override
    const workerEnv = {
      ...process.env,
      ...this.inheritedEnv,
      DEPLOYMENT_NAME: deployment,
      SINGLE_MODE: 'false'  // Signal that this is running in multi-mode
    };

    const child = spawn('node', [workerPath], {
      env: workerEnv,
      stdio: ['ignore', 'inherit', 'inherit'],  // Inherit stdout/stderr for logging
      detached: false  // Keep as child (not detached)
    });

    // Bind child process exit handler
    child.on('exit', (code, signal) => {
      console.warn(
        `⚠️ Worker for ${deployment} exited ` +
        `(code: ${code}, signal: ${signal})`
      );

      // Remove from children map
      this.children.delete(deployment);

      // Auto-restart after 5 seconds if not explicitly stopped
      setTimeout(() => {
        if (!this.children.has(deployment)) {
          console.log(`↻ Restarting worker for ${deployment}...`);
          this.startWorker(deployment);
        }
      }, 5000);
    });

    child.on('error', (error) => {
      console.error(`❌ Error starting worker for ${deployment}: ${error.message}`);
    });

    // Store reference to child process
    this.children.set(deployment, child);
  }

  /**
   * Stop all deployment workers gracefully
   */
  stopAll() {
    console.log(`⏹️  Stopping all ${this.children.size} worker(s)...`);

    for (const [deployment, child] of this.children.entries()) {
      if (child && child.kill) {
        console.log(`Stopping worker for ${deployment}...`);
        child.kill('SIGTERM');
      }
    }

    this.children.clear();
    console.log('✓ All workers stopped');
  }

  /**
   * Stop and restart all workers (for debugging/reconfiguration)
   */
  async restartAll() {
    console.log('🔄 Restarting all workers...');
    this.stopAll();

    // Wait a bit for children to exit
    await new Promise(resolve => setTimeout(resolve, 1000));

    this.startAll();
  }

  /**
   * Get status of all workers
   */
  getStatus() {
    const status = {
      totalDeployments: this.deployments.length,
      runningWorkers: this.children.size,
      workers: []
    };

    for (const deployment of this.deployments) {
      const child = this.children.get(deployment);
      status.workers.push({
        deployment,
        running: this.children.has(deployment),
        pid: child ? child.pid : null
      });
    }

    return status;
  }

  /**
   * Handle graceful shutdown (SIGTERM/SIGINT)
   */
  onShutdown(callback) {
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully...');
      this.stopAll();
      if (callback) callback();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down gracefully...');
      this.stopAll();
      if (callback) callback();
      process.exit(0);
    });
  }
}

module.exports = DeploymentManager;
