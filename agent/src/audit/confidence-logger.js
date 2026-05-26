/**
 * Low Confidence Logger
 * Records decisions where confidence falls below threshold
 * Creates a feedback loop for tuning thresholds and improving the runbook
 */

const fs = require('fs').promises;
const path = require('path');

class LowConfidenceLogger {
  constructor(logPath = '/agent/audit/low-confidence.jsonl', confidenceThreshold = 0.6) {
    this.logPath = logPath;
    this.threshold = confidenceThreshold;
    this.initialize();
  }

  /**
   * Ensure log directory exists
   */
  async initialize() {
    try {
      const dir = path.dirname(this.logPath);
      await fs.mkdir(dir, { recursive: true });
      console.log(`Low-confidence logger initialized (threshold: ${this.threshold})`);
    } catch (error) {
      console.error('Failed to initialize low-confidence logger:', error.message);
    }
  }

  /**
   * Log a decision if confidence is below threshold
   * @param {Object} decisionData - Complete decision context
   */
  async logIfNeeded(decisionData) {
    const { confidence, action, diagnosis, reasoning, logs } = decisionData;

    // Log if:
    // 1. Confidence is below threshold, OR
    // 2. Action is log_only (uncertain) with any confidence below 0.75
    const shouldLog = (confidence < this.threshold) ||
                      (action === 'log_only' && confidence < 0.75);

    if (!shouldLog) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      id: this.generateId(),
      confidence: confidence,
      action_taken: action,
      threshold: this.threshold,
      gap: (this.threshold - confidence).toFixed(2),

      // Full context for review
      diagnosis: {
        issue_type: diagnosis?.issue_type || 'unknown',
        root_cause: diagnosis?.root_cause || 'unknown',
        severity: diagnosis?.severity || 'unknown',
        evidence: diagnosis?.evidence || ''
      },

      reasoning: reasoning,

      // Log sample that triggered this (last 5 lines)
      log_sample: logs?.slice(-5) || [],

      // For tuning suggestions
      tuning_suggestion: this.suggestTuning(diagnosis, confidence)
    };

    try {
      await fs.appendFile(this.logPath, JSON.stringify(entry) + '\n');
      console.log(`Low-confidence decision logged (confidence: ${(confidence * 100).toFixed(1)}%, threshold: ${(this.threshold * 100).toFixed(1)}%)`);
    } catch (error) {
      console.error('Failed to write low-confidence log:', error.message);
    }
  }

  /**
   * Generate tuning suggestions based on patterns
   */
  suggestTuning(diagnosis, confidence) {
    if (!diagnosis) return 'Review runbook entries for this issue type';

    const suggestions = [];

    if (diagnosis.severity === 'critical' && confidence < 0.7) {
      suggestions.push('Consider lowering confidence threshold for critical severity issues');
    }

    if (diagnosis.issue_type === 'normal' && confidence < 0.8) {
      suggestions.push('Runbook may need more examples of normal operation patterns');
    }

    if (diagnosis.issue_type === 'unknown' || diagnosis.issue_type === 'Analysis error') {
      suggestions.push('Add this pattern to runbook for better recognition');
    }

    if (diagnosis.root_cause === 'unknown') {
      suggestions.push('Root cause unclear - review logs for hidden patterns');
    }

    return suggestions.length > 0 ? suggestions.join('; ') : 'Monitor for pattern recurrence';
  }

  /**
   * Review low-confidence logs and generate report
   * Call this periodically to tune the agent
   */
  async generateReviewReport() {
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      if (lines.length === 0) {
        return { message: 'No low-confidence decisions to review' };
      }

      const logs = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error('Failed to parse log line:', e.message);
          return null;
        }
      }).filter(log => log !== null);

      // Group by issue type
      const byIssueType = {};
      logs.forEach(log => {
        const issue = log.diagnosis?.issue_type || 'unknown';
        if (!byIssueType[issue]) {
          byIssueType[issue] = { count: 0, avgConfidence: 0, actions: {}, logs: [] };
        }
        byIssueType[issue].count++;
        byIssueType[issue].avgConfidence += log.confidence;

        // Track which actions were taken for this issue
        const action = log.action_taken || 'unknown';
        byIssueType[issue].actions[action] = (byIssueType[issue].actions[action] || 0) + 1;

        byIssueType[issue].logs.push(log);
      });

      // Calculate averages
      Object.keys(byIssueType).forEach(issue => {
        byIssueType[issue].avgConfidence =
          (byIssueType[issue].avgConfidence / byIssueType[issue].count).toFixed(2);
      });

      const report = {
        generated_at: new Date().toISOString(),
        total_low_confidence_decisions: logs.length,
        by_issue_type: byIssueType,
        tuning_recommendations: this.generateRecommendations(byIssueType),
        recent_entries: logs.slice(-5)
      };

      return report;
    } catch (error) {
      return { error: 'No low-confidence logs found yet', message: error.message };
    }
  }

  /**
   * Generate actionable recommendations
   */
  generateRecommendations(byIssueType) {
    const recommendations = [];

    for (const [issue, data] of Object.entries(byIssueType)) {
      if (data.count > 2 && data.avgConfidence < 0.55) {
        recommendations.push({
          issue_type: issue,
          recommendation: `Add clearer examples of "${issue}" to runbook`,
          current_avg_confidence: parseFloat(data.avgConfidence),
          occurrences: data.count,
          actions_taken: data.actions
        });
      }
    }

    return recommendations;
  }

  generateId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `lowconf-${timestamp}-${random}`;
  }
}

module.exports = LowConfidenceLogger;
