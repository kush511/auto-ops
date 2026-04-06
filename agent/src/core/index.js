#!/usr/bin/env node

const AuditLogger = require('../audit/logger');
const SlackAlert = require('../alerts/slack');
const LowConfidenceLogger = require('../audit/confidence-logger');
const TwoStageLLM = require('./two-stage');
const ActionExecutor = require('./action-executor');
require('dotenv').config();

/**
 * Auto-Ops Agent Main Class
 * Phase 3: Two-stage LLM reasoning with runbook context
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

    this.deploymentName = process.env.DEPLOYMENT_NAME || 'app-deployment';
    this.namespace = process.env.K8S_NAMESPACE || 'default';
    this.checkInterval = parseInt(process.env.CHECK_INTERVAL) || 30000;
    this.actionCooldownMs = parseInt(process.env.ACTION_COOLDOWN_MS) || 120000;
    this.lastSuccessfulActionAt = new Map();

    // Initialize TwoStageLLM with runbook path
    const runbookPath = process.env.RUNBOOK_PATH || './agent/runbook.md';
    this.llm = new TwoStageLLM(process.env.INCEPTION_API_KEY, runbookPath);

    // Load runbook asynchronously
    this.llm.loadRunbook().catch(err =>
      console.error('Failed to load runbook:', err.message)
    );

    // Initialize ActionExecutor
    this.executor = new ActionExecutor(this.deploymentName, this.namespace);

    // Hybrid scale-down tracking
    this.healthyCycles = 0;
    this.healthyCycleThreshold = parseInt(process.env.HEALTHY_CYCLE_THRESHOLD) || 3;
    console.log(` Healthy cycle threshold: ${this.healthyCycleThreshold} cycles before scale down`);

    // Initialize Low Confidence Logger for Phase 3.4
    const confLogPath = process.env.LOW_CONFIDENCE_LOG_PATH || '/agent/audit/low-confidence.jsonl';
    const confThreshold = parseFloat(process.env.LOW_CONFIDENCE_THRESHOLD) || 0.6;
    this.confidenceLogger = new LowConfidenceLogger(confLogPath, confThreshold);
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
   * Collect logs from the application
   * For now, we'll fetch from kubectl
   */
  async collectLogs() {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    try {
      const { stdout } = await execPromise(
        `kubectl logs deployment/${this.deploymentName} -n ${this.namespace} --tail=50 2>/dev/null || echo "No logs found"`
      );
      return stdout.split('\n').filter((line) => line.trim());
    } catch (error) {
      console.error('Failed to collect logs:', error.message);
      return [];
    }
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

    const logs = await this.collectLogs();
    console.log(` Collected ${logs.length} log lines`);

    // Stage 1 & 2: Two-stage LLM reasoning
    const llmResult = await this.llm.analyze(logs);
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
      const params = {};

      // Add action-specific parameters
      if (actionName === 'scale') {
        params.replicas = llmResult.plan?.parameters?.replicas || 3;
      } else if (actionName === 'scaleDown') {
        params.replicas = llmResult.plan?.parameters?.replicas || 1;
      }

      actionTaken = await this.executor.execute(actionName, params);

      if (actionTaken?.success) {
        this.markActionExecuted(actionLegacy, analysis);
        // Reset healthy cycles after successful action
        if (actionName === 'scaleDown') {
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
  start() {
    console.log(' Auto-Ops Agent v3.0 Starting...');
    console.log(` Target deployment: ${this.deploymentName} (namespace: ${this.namespace})`);
    console.log(`  Check interval: ${this.checkInterval / 1000} seconds`);
    console.log(`  Action cooldown: ${this.actionCooldownMs / 1000} seconds`);
    console.log(` Phase 3: Two-stage LLM reasoning with runbook context`);
    console.log('----------------------------------------\n');

    this.runCycle().catch(console.error);

    setInterval(() => {
      this.runCycle().catch(console.error);
    }, this.checkInterval);
  }
}

if (require.main === module) {
  const agent = new AutoOpsAgent();
  agent.start();
}

module.exports = AutoOpsAgent;