#!/usr/bin/env node

const AuditLogger = require('../audit/logger');
const SlackAlert = require('../alerts/slack');
const LowConfidenceLogger = require('../audit/confidence-logger');
const TwoStageLLM = require('./two-stage');
const ActionExecutor = require('./action-executor');
const HeartbeatWriter = require('./heartbeat');
const PrometheusClient = require('../metrics/prometheus-client');
const LogStreamManager = require('./log-stream');
const DeploymentManager = require('./deployment-manager');
const ApprovalManager = require('./approval-manager');
const SlackCallbackServer = require('../callbacks/slack-callback-server');
require('dotenv').config();

/**
 * Auto-Ops Agent Main Class
 * Phase 4: Production hardening with multi-deployment, metrics, and liveness checks
 */
class AutoOpsAgent {
  constructor() {
    const auditPath = process.env.AUDIT_LOG_PATH || './audit/actions.jsonl';
    this.auditLogger = new AuditLogger(auditPath);

    if (process.env.SLACK_WEBHOOK_URL) {
      this.slack = new SlackAlert(process.env.SLACK_WEBHOOK_URL, {
        maxAlertsPerHour: 10
      });
      console.log(' Slack alerts enabled');
    } else {
      console.log(' Slack alerts disabled (no webhook URL)');
    }

    // Parse deployments - can be single or comma-separated list
    const deploymentsList = process.env.DEPLOYMENTS || 'app-deployment';
    this.deployments = deploymentsList.split(',').map(d => d.trim());
    this.deploymentName = this.deployments[0];  // Primary deployment for single-mode

    this.namespace = process.env.K8S_NAMESPACE || 'default';
    this.checkInterval = parseInt(process.env.CHECK_INTERVAL) || 30000;
    this.actionCooldownMs = parseInt(process.env.ACTION_COOLDOWN_MS) || 120000;
    this.lastSuccessfulActionAt = new Map();

    // Initialize TwoStageLLM with runbook path and optional PrometheusClient
    const runbookPath = process.env.RUNBOOK_PATH || './agent/runbook.md';
    const prometheusUrl = process.env.PROMETHEUS_URL || 'http://prometheus-operated.monitoring.svc.cluster.local:9090';
    const prometheusClient = new PrometheusClient(prometheusUrl);
    this.llm = new TwoStageLLM(process.env.INCEPTION_API_KEY, runbookPath, prometheusClient);

    // Load runbook asynchronously
    this.llm.loadRunbook().catch(err =>
      console.error('Failed to load runbook:', err.message)
    );

    // Initialize ApprovalManager for Slack approval workflow
    const approvalLogPath = process.env.APPROVAL_LOG_PATH || '/agent/audit/approvals.jsonl';
    const approvalTimeoutMs = parseInt(process.env.APPROVAL_TIMEOUT_MS) || 300000;  // 5 minutes
    this.approvalManager = new ApprovalManager(approvalLogPath, approvalTimeoutMs);
    this.approvalManager.initialize().catch(err =>
      console.error('Failed to initialize approval manager:', err.message)
    );

    // Initialize ActionExecutor with approval manager and Slack alerts
    this.executor = new ActionExecutor(this.deploymentName, this.namespace, this.approvalManager, this.slack);

    // Initialize SlackCallbackServer for handling approvals (will start in start() method)
    this.callbackServer = null;
    if (process.env.SLACK_SIGNING_SECRET && process.env.SLACK_WEBHOOK_URL) {
      const callbackPort = parseInt(process.env.CALLBACK_PORT) || 3001;
      this.callbackServer = new SlackCallbackServer(this.approvalManager, this.executor, this.slack, callbackPort);
      console.log(` Slack callback server configured for port ${callbackPort}`);
    } else {
      console.log(' Slack callback server disabled (missing SLACK_SIGNING_SECRET or SLACK_WEBHOOK_URL)');
    }

    // Initialize HeartbeatWriter for dead man's switch (Phase 4.3)
    const heartbeatPath = process.env.HEARTBEAT_PATH || '/agent/heartbeat/timestamp.txt';
    this.heartbeat = new HeartbeatWriter(heartbeatPath);

    // Initialize LogStreamManager with exponential backoff (Phase 4.4)
    this.logStream = new LogStreamManager(this.deploymentName, this.namespace);

    // Hybrid scale-down tracking
    this.healthyCycles = 0;
    this.healthyCycleThreshold = parseInt(process.env.HEALTHY_CYCLE_THRESHOLD) || 3;
    console.log(` Healthy cycle threshold: ${this.healthyCycleThreshold} cycles before scale down`);

    // Initialize Low Confidence Logger for Phase 3.4
    const confLogPath = process.env.LOW_CONFIDENCE_LOG_PATH || '/agent/audit/low-confidence.jsonl';
    const confThreshold = parseFloat(process.env.LOW_CONFIDENCE_THRESHOLD) || 0.6;
    this.confidenceLogger = new LowConfidenceLogger(confLogPath, confThreshold);

    // Multi-deployment manager (only initialized if multiple deployments)
    this.deploymentManager = null;
  }

  buildActionSignature(action, analysis) {
    const issue = (analysis?.issue || 'unknown_issue').trim().toLowerCase();
    return `${this.deploymentName}:${action}:${issue}`;
  }

  shouldSuppressDuplicateAction(action, analysis) {
    if (!action || action === 'log_only') return false;

    const signature = this.buildActionSignature(action, analysis);
    const lastAt = this.lastSuccessfulActionAt.get(signature);
    if (!lastAt) return false;

    return Date.now() - lastAt < this.actionCooldownMs;
  }

  markActionExecuted(action, analysis) {
    if (!action || action === 'log_only') return;
    const signature = this.buildActionSignature(action, analysis);
    this.lastSuccessfulActionAt.set(signature, Date.now());
  }

  /**
   * Collect logs using LogStreamManager with exponential backoff retry
   * Handles pod restarts gracefully with 15-20 second connection timeout
   */
  async collectLogs() {
    return await this.logStream.collectLogsWithBackoff();
  }

  /**
   * Map new action names to old names for backward compatibility
   */
  mapActionName(newAction) {
    const mapping = {
      'restart': 'restart_service',
      'scale': 'scale_service',
      'scaleDown': 'scale_down_service',
      'rollback': 'rollback_service',
      'log_only': 'log_only'
    };
    return mapping[newAction] || newAction;
  }

  /**
   * Check if we should recommend scale down based on healthy cycles
   */
  shouldScaleDown(currentReplicas, llmResult) {
    // Only consider scale down if:
    // 1. Current replicas > 1 (something to scale down from)
    // 2. LLM recommends log_only (normal operation)
    // 3. We've had N consecutive healthy cycles

    if (currentReplicas <= 1) {
      return false;  // Already at minimum
    }

    if (llmResult.action !== 'log_only') {
      return false;  // Not normal operation
    }

    // We're in normal operation, increment healthy cycles
    this.healthyCycles++;
    console.log(` Healthy cycles: ${this.healthyCycles}/${this.healthyCycleThreshold}`);

    if (this.healthyCycles >= this.healthyCycleThreshold) {
      console.log(` ✅ Threshold reached! Ready to scale down.`);
      return true;
    }

    return false;
  }

  /**
   * Reset healthy cycle counter on any issue
   */
  resetHealthyCycles(reason) {
    if (this.healthyCycles > 0) {
      console.log(` ⚠️ Resetting healthy cycles (${reason})`);
      this.healthyCycles = 0;
    }
  }

  /**
   * Main monitoring cycle
   */
  async runCycle() {
    console.log('\n ===== Monitoring Cycle Started =====');
    console.log(` Checking deployment: ${this.deploymentName}`);

    // Check for expired approvals
    await this.approvalManager.expireOldApprovals();

    const logs = await this.collectLogs();
    console.log(` Collected ${logs.length} log lines`);

    // Stage 1 & 2: Two-stage LLM reasoning with optional Prometheus metrics
    const llmResult = await this.llm.analyze(logs, this.deploymentName, this.namespace);
    console.log(`\n 📊 LLM Analysis Result:`);
    console.log(`   Diagnosis: ${llmResult.diagnosis?.issue_type || 'Unknown'}`);
    console.log(`   Plan Action: ${llmResult.action}`);
    console.log(`   Confidence: ${(llmResult.confidence * 100).toFixed(1)}%`);

    // Get current replicas for scale down decision
    const currentReplicas = await this.getCurrentReplicas();

    let actionName = llmResult.action || 'log_only';  // New action name (restart, scale, rollback, log_only)

    // Hybrid logic: Check if we should recommend scale down
    if (this.shouldScaleDown(currentReplicas, llmResult)) {
      console.log(` 📉 Promoting action to scaleDown (healthy cycles threshold met)`);
      actionName = 'scaleDown';  // Override to scale down
    } else if (actionName !== 'log_only') {
      // Any non-healthy action resets the cycle counter
      this.resetHealthyCycles(`non-healthy action: ${actionName}`);
    }

    let actionLegacy = this.mapActionName(actionName);  // Legacy name for audit (restart_service, etc.)
    let actionTaken = null;
    let actionSuppressed = false;

    // Build analysis object for backward compatibility
    const analysis = {
      issue: llmResult.diagnosis?.issue_type || 'Analysis complete',
      severity: llmResult.diagnosis?.severity || 'low',
      confidence: llmResult.confidence,
      reasoning: llmResult.reasoning
    };

    const reasoningText = llmResult.reasoning || 'AI detected anomaly';

    if (this.shouldSuppressDuplicateAction(actionLegacy, analysis)) {
      actionSuppressed = true;
      console.log(` Duplicate action suppressed: ${actionLegacy} (cooldown ${this.actionCooldownMs / 1000}s)`);
    }

    // Execute action via ActionExecutor
    if (!actionSuppressed && actionName !== 'log_only') {
      const params = {
        confidence: llmResult.confidence  // Pass confidence for approval requests
      };

      // Add action-specific parameters
      if (actionName === 'scale') {
        params.replicas = llmResult.plan?.parameters?.replicas || 3;
      } else if (actionName === 'scaleDown') {
        params.replicas = llmResult.plan?.parameters?.replicas || 1;
      }

      actionTaken = await this.executor.execute(actionName, params);

      if (actionTaken?.success || actionTaken?.queued) {
        // Mark action executed for both immediate execution and approval queuing
        this.markActionExecuted(actionLegacy, analysis);
        // Reset healthy cycles after successful action
        if (actionName === 'scaleDown' && actionTaken?.success) {
          this.healthyCycles = 0;  // Reset counter after scaling down
          console.log(` Healthy cycles reset after scale down`);
        }
      }
    } else if (!actionSuppressed && actionName === 'log_only') {
      actionTaken = await this.executor.execute('log_only');
    } else if (actionSuppressed) {
      actionLegacy = 'suppressed_duplicate_action';
      console.log(' Action suppressed — no kubectl call needed');
    }

    // Audit logging (backward compatible format)
    const auditEntry = await this.auditLogger.log({
      deployment: this.deploymentName,
      namespace: this.namespace,
      issue: analysis.issue,
      severity: analysis.severity,
      confidence: analysis.confidence,
      action: actionLegacy,
      action_success: actionTaken ? actionTaken.success : null,
      diagnosis: llmResult.diagnosis,
      plan: llmResult.plan,
      reasoning: reasoningText,
      log_sample: logs.slice(0, 10)
    });

    // Phase 3.4: Log low-confidence decisions for tuning
    await this.confidenceLogger.logIfNeeded({
      confidence: llmResult.confidence,
      action: actionName,
      diagnosis: llmResult.diagnosis,
      reasoning: reasoningText,
      logs: logs
    });

    // Slack notification
    const shouldNotify = !actionSuppressed && actionName !== 'log_only';
    if (shouldNotify) {
      if (this.slack) {
        await this.slack.send({
          issueType: (analysis.issue || 'unknown_issue').replace(/\s+/g, '_').toLowerCase(),
          deployment: this.deploymentName,
          issue: analysis.issue || 'Unknown issue',
          severity: analysis.severity || 'low',
          confidence: analysis.confidence,
          action: actionLegacy,
          reasoning: `${reasoningText}${auditEntry?.id ? ` | audit_id=${auditEntry.id}` : ''}`
        });
      } else {
        console.log(' Slack alert would be sent here (no webhook configured)');
      }
    } else {
      console.log(' Slack alert skipped (no action taken)');
    }

    console.log(' ===== Cycle Complete =====');
    return { analysis, action: actionLegacy, auditEntry };
  }

  async getCurrentReplicas() {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    try {
      const { stdout } = await execPromise(
        `kubectl get deployment ${this.deploymentName} -n ${this.namespace} -o jsonpath='{.spec.replicas}'`
      );
      return parseInt(stdout.trim(), 10) || 1;
    } catch (error) {
      console.error('❌ Failed to get replica count:', error.message);
      return 1;
    }
  }

  /**
   * Start the agent
   */
  async start() {
    console.log(' Auto-Ops Agent v4.0 Starting...');
    console.log(` Deployment(s): ${this.deployments.join(', ')}`);
    console.log(` Namespace: ${this.namespace}`);
    console.log(`  Check interval: ${this.checkInterval / 1000} seconds`);
    console.log(`  Action cooldown: ${this.actionCooldownMs / 1000} seconds`);
    console.log(` Phase 4: Production hardening with metrics, multi-deployment, and liveness`);
    console.log('----------------------------------------\n');

    // Initialize heartbeat for dead man's switch
    try {
      const heartbeatInitialized = await this.heartbeat.initialize();
      if (heartbeatInitialized) {
        this.heartbeat.startHeartbeat(60000);  // 60 second heartbeat interval
      }
    } catch (error) {
      console.warn(`❌ Failed to initialize heartbeat: ${error.message}`);
    }

    // Start Slack callback server if configured
    if (this.callbackServer) {
      try {
        this.callbackServer.start();
      } catch (error) {
        console.error(`❌ Failed to start Slack callback server: ${error.message}`);
      }
    }

    // Detect single vs multi-deployment mode
    if (this.deployments.length > 1) {
      console.log(` Multi-deployment mode: ${this.deployments.length} deployments`);
      // Spawn DeploymentManager to handle parallel workers
      this.deploymentManager = new DeploymentManager(this.deployments);
      this.deploymentManager.startAll();
      // Set up graceful shutdown
      this.deploymentManager.onShutdown(() => {
        console.log('Agent shutting down gracefully');
      });
    } else {
      console.log(` Single-deployment mode: ${this.deploymentName}`);
      // Run single-deployment monitoring loop
      this.runCycle().catch(console.error);
      setInterval(() => {
        this.runCycle().catch(console.error);
      }, this.checkInterval);
    }
  }
}

if (require.main === module) {
  const agent = new AutoOpsAgent();
  agent.start().catch(console.error);
}

module.exports = AutoOpsAgent;