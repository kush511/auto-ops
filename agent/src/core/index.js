#!/usr/bin/env node

const AuditLogger = require('../audit/logger');
const SlackAlert = require('../alerts/slack');
const analyzeLogsWithAi = require('./ai');
const decideAction = require('./decision');
const actions = require('./actions');
require('dotenv').config();

/**
 * Auto-Ops Agent Main Class
 * Phase 2: Adds audit logging and Slack alerts
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
   * Fallback log analysis when INCEPTION_API_KEY is unavailable.
   */
  simulateAnalyzeLogs(logs) {
    const hasErrors = logs.some((line) =>
      line.includes('error') || line.includes('500') || line.includes('Exception')
    );

    if (hasErrors) {
      return {
        issue: 'High error rate detected in application logs',
        severity: 'high',
        confidence: 0.85,
        suggested_action: 'restart',
        reasoning: 'Multiple error patterns detected in recent logs'
      };
    }

    return {
      issue: 'System operating normally',
      severity: 'low',
      confidence: 0.95,
      suggested_action: 'none',
      reasoning: 'No anomalies detected in log patterns'
    };
  }

  async analyzeLogs(logs) {
    if (process.env.INCEPTION_API_KEY) {
      const aiResult = await analyzeLogsWithAi(logs.join('\n'));
      if (aiResult) {
        return aiResult;
      }
      console.log('⚠️ AI analysis unavailable, using fallback simulator');
    }
    return this.simulateAnalyzeLogs(logs);
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
   * Main monitoring cycle
   */
  async runCycle() {
    console.log('\n ===== Monitoring Cycle Started =====');
    console.log(` Checking deployment: ${this.deploymentName}`);

    const logs = await this.collectLogs();
    console.log(` Collected ${logs.length} log lines`);

    const analysis = await this.analyzeLogs(logs);
    console.log(` Analysis: ${analysis.issue}`);
    console.log(`   Severity: ${analysis.severity} | Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);

    let action = 'log_only';
    let actionTaken = null;
    let actionSuppressed = false;

    const currentReplicas = await this.getCurrentReplicas();
    const decision = decideAction(analysis, currentReplicas);
    action = decision.action;
    const reasoningText = analysis.reasoning || decision.reason || 'AI detected anomaly';

    if (this.shouldSuppressDuplicateAction(action, analysis)) {
      actionSuppressed = true;
      console.log(` Duplicate action suppressed: ${action} (cooldown ${this.actionCooldownMs / 1000}s)`);
    }

    if (!actionSuppressed && decision.action === 'restart_service') {
      actionTaken = await actions.restartDeployment(this.deploymentName, this.namespace);
      if (actionTaken?.success) this.markActionExecuted(action, analysis);
    } else if (!actionSuppressed && decision.action === 'scale_service') {
      actionTaken = await actions.scaleDeployment(this.deploymentName, this.namespace, 3);
      if (actionTaken?.success) this.markActionExecuted(action, analysis);
    } else if (!actionSuppressed && decision.action === 'scale_down_service') {
      actionTaken = await actions.scaleDownDeployment(this.deploymentName, this.namespace, 1);
      if (actionTaken?.success) this.markActionExecuted(action, analysis);
    } else if (actionSuppressed) {
      action = 'suppressed_duplicate_action';
      console.log(' Action suppressed — no kubectl call needed');
    } else {
      console.log(` Action: ${decision.action} — no kubectl call needed`);
    }

    const auditEntry = await this.auditLogger.log({
      deployment: this.deploymentName,
      namespace: this.namespace,
      issue: analysis.issue,
      severity: analysis.severity,
      confidence: analysis.confidence,
      action: action,
      action_success: actionTaken ? actionTaken.success : null,
      decision,
      reasoning: reasoningText,
      log_sample: logs.slice(0, 10)
    });

    const shouldNotify = !actionSuppressed && action !== 'log_only';
    if (shouldNotify) {
      if (this.slack) {
        await this.slack.send({
          issueType: (analysis.issue || 'unknown_issue').replace(/\s+/g, '_').toLowerCase(),
          deployment: this.deploymentName,
          issue: analysis.issue || 'Unknown issue',
          severity: analysis.severity || 'low',
          confidence: analysis.confidence,
          action: action,
          reasoning: `${reasoningText}${auditEntry?.id ? ` | audit_id=${auditEntry.id}` : ''}`
        });
      } else {
        console.log(' Slack alert would be sent here (no webhook configured)');
      }
    } else {
      console.log(' Slack alert skipped (no action taken)');
    }

    console.log(' ===== Cycle Complete =====');
    return { analysis, action, auditEntry };
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
    console.log(' Auto-Ops Agent v2.0 Starting...');
    console.log(` Target deployment: ${this.deploymentName} (namespace: ${this.namespace})`);
    console.log(`  Check interval: ${this.checkInterval / 1000} seconds`);
    console.log(`  Action cooldown: ${this.actionCooldownMs / 1000} seconds`);
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