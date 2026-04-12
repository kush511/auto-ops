#!/usr/bin/env node

/**
 * Deployment Worker
 *
 * This script is spawned as a separate Node.js child process by DeploymentManager.
 * Each worker monitors a single deployment and reports actions back to the parent.
 *
 * Environment variables (set by DeploymentManager):
 * - DEPLOYMENT_NAME: The deployment this worker monitors
 * - SINGLE_MODE: false (indicates multi-deployment mode)
 * - All other inherited from parent process
 */

const AutoOpsAgent = require('./index');

async function start() {
  const deployment = process.env.DEPLOYMENT_NAME || 'app-deployment';

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Deployment Worker Started
  Deployment: ${deployment}
  PID: ${process.pid}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  try {
    // Create and start a new agent instance for this deployment
    // The agent constructor will use the DEPLOYMENT_NAME env var
    const agent = new AutoOpsAgent();

    // Start the monitoring loop
    await agent.start();

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      console.log(`[${deployment}] SIGTERM received, shutting down gracefully...`);
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log(`[${deployment}] SIGINT received, shutting down...`);
      process.exit(0);
    });

  } catch (error) {
    console.error(`❌ Failed to start worker for ${deployment}:`, error);
    process.exit(1);
  }
}

// Start the worker
start();
