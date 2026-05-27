/**
 * Two-stage LLM reasoning
 * Stage 1: Diagnose - What is happening?
 * Stage 2: Plan - What should we do?
 *
 * Includes optional Prometheus metrics for enriched context.
 */

class TwoStageLLM {
  constructor(apiKey, runbookPath = null, prometheusClient = null) {
    this.apiKey = apiKey;
    this.runbook = null;
    this.runbookPath = runbookPath;
    this.prometheusClient = prometheusClient;  // Optional: PrometheusClient instance
  }

  /**
   * Load runbook from file
   */
  async loadRunbook() {
    const fs = require('fs').promises;
    try {
      this.runbook = await fs.readFile(this.runbookPath, 'utf8');
      console.log(' Runbook loaded successfully');
    } catch (error) {
      console.log(' No runbook found, continuing without');
      this.runbook = 'No specific runbook available. Use general Kubernetes knowledge.';
    }
  }

  /**
   * Filter logs to only include recent entries (last N seconds)
   * Parses JSON logs with timestamp field
   */
  filterRecentLogs(logs, secondsBack = 30) {
    const cutoffTime = Date.now() - (secondsBack * 1000);

    return logs.filter(line => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.timestamp) {
          const logTime = new Date(parsed.timestamp).getTime();
          return logTime >= cutoffTime;
        }
        // If no timestamp, include it (safer approach)
        return true;
      } catch (e) {
        // Non-JSON logs - include them
        return true;
      }
    });
  }

  /**
   * Stage 1: Diagnose the problem
   * @param {Array} logs - Recent log lines
   * @returns {Object} Diagnosis
   */
  async diagnose(logs, deployment = null, namespace = 'default') {
    // Filter to only recent logs (last 30 seconds)
    const recentLogs = this.filterRecentLogs(logs, 30);
    const logText = recentLogs.slice(-20).join('\n');

    const runbookPatterns = this.runbook
      ? `\nKnown failure patterns from runbook:\n${this.runbook}\n`
      : '';

    // Query Prometheus metrics if available
    let metricsContext = '';
    if (this.prometheusClient && deployment) {
      try {
        const metrics = await this.prometheusClient.queryMetrics(deployment, namespace);
        if (metrics) {
          metricsContext = `\n${this.prometheusClient.formatMetricsForPrompt(metrics)}\n`;
        } else {
          metricsContext = '\nCurrent metrics: Prometheus unavailable\n';
        }
      } catch (error) {
        console.warn(`Failed to query Prometheus: ${error.message}`);
        metricsContext = '\nCurrent metrics: Failed to retrieve\n';
      }
    }

    const prompt = `You are a Kubernetes SRE diagnosing an application issue.

${runbookPatterns}
Logs from the last 30 seconds:
"""
${logText}
"""

CRITICAL RULES:
1. Match patterns against the runbook patterns above
2. ONLY report patterns that are EXPLICITLY visible in the logs
3. DO NOT make up or infer issues - if logs are clean, severity = "low"
4. If confidence < 0.4, mark as low confidence anomaly

Analyze these logs and return ONLY valid JSON with this structure:
{
  "issue_type": "string (e.g., '5xx error spike', 'high latency', 'crash loop', 'normal', 'DB_TIMEOUT spike', etc.)",
  "root_cause": "string (likely root cause based on logs)",
  "severity": "string (critical/high/medium/low)",
  "confidence": "number (0-1, based on runbook thresholds)",
  "evidence": "string (specific log lines that support diagnosis)"
}

Do not include any other text, only the JSON.`;

    const response = await this.callLLM(prompt);

    // Handle LLM API failure
    if (!response) {
      console.error('❌ LLM API unavailable, using fallback diagnosis');
      return {
        issue_type: 'LLM error',
        root_cause: 'Inception API unreachable',
        severity: 'low',
        confidence: 0.2,
        evidence: 'LLM API call failed - unable to analyze'
      };
    }

    let diagnosis;
    try {
      diagnosis = JSON.parse(response);
    } catch (error) {
      console.error('❌ Failed to parse diagnosis response:', error.message);
      return {
        issue_type: 'Analysis error',
        root_cause: 'LLM returned invalid JSON',
        severity: 'medium',
        confidence: 0.3,
        evidence: 'Failed to parse LLM response'
      };
    }

    console.log(`Stage 1 Diagnosis:`);
    console.log(`   Issue: ${diagnosis.issue_type}`);
    console.log(`   Severity: ${diagnosis.severity}`);
    console.log(`   Confidence: ${diagnosis.confidence}`);

    return diagnosis;
  }

  /**
   * Stage 2: Plan the action
   * @param {Object} diagnosis - From stage 1
   * @param {Array} logs - Original logs
   * @returns {Object} Action plan
   */
  async plan(diagnosis, logs) {
    const recentLogs = this.filterRecentLogs(logs, 30);
    const logText = recentLogs.slice(-10).join('\n');

    const runbookContext = this.runbook
      ? `\nRunbook reference:\n${this.runbook}\n`
      : '';

    const prompt = `You are a Kubernetes SRE planning remediation.

Diagnosis from previous analysis:
- Issue: ${diagnosis.issue_type}
- Root cause: ${diagnosis.root_cause}
- Severity: ${diagnosis.severity}
- Diagnosis confidence: ${diagnosis.confidence}

Recent logs (last 10 lines):
"""
${logText}
"""
${runbookContext}

Available actions:
- restart: Restart the deployment (good for temporary issues, memory leaks, DB_TIMEOUT)
- scale: Increase replicas to 3 (good for traffic spikes, latency, memory pressure)
- scaleDown: Reduce replicas to 1 (good for normal operation, scaling down after scale up)
- rollback: Revert to previous version (good for bad deploys, crash loops, config errors, image pull failures)
- log_only: Take no action, just log (for low confidence or normal operation)

CRITICAL RULES:
1. Match diagnosis against runbook patterns to determine confidence thresholds
2. If diagnosis confidence < 0.4, recommend log_only
3. For crashes, manifests missing, config errors → rollback (never restart)
4. For DB_TIMEOUT, memory issues → restart or scale
5. Return action parameters (especially replicas for scale/scaleDown)

Return ONLY valid JSON with this structure:
{
  "recommended_action": "string (restart/scale/scaleDown/rollback/log_only)",
  "reasoning": "string (why this action, maps to runbook if applicable)",
  "confidence": "number (0-1, action confidence)",
  "parameters": {
    "replicas": "number (for scale: 3, for scaleDown: 1, otherwise omit)"
  }
}

Do not include any other text, only the JSON.`;

    const response = await this.callLLM(prompt);

    // Handle LLM API failure
    if (!response) {
      console.error(' LLM API unavailable, falling back to log_only');
      return {
        recommended_action: 'log_only',
        reasoning: 'LLM API unreachable - cannot generate plan',
        confidence: 0.1,
        parameters: {}
      };
    }

    let plan;
    try {
      plan = JSON.parse(response);
    } catch (error) {
      console.error(' Failed to parse plan response:', error.message);
      return {
        recommended_action: 'log_only',
        reasoning: 'LLM returned invalid JSON for action plan',
        confidence: 0.2,
        parameters: {}
      };
    }

    console.log(`Stage 2 Plan:`);
    console.log(`   Action: ${plan.recommended_action}`);
    console.log(`   Reasoning: ${plan.reasoning}`);
    console.log(`   Confidence: ${plan.confidence}`);

    return plan;
  }

  /**
   * Call LLM API using Inception API
   */
  async callLLM(prompt) {
    if (!this.apiKey) {
      console.error('⚠️ INCEPTION_API_KEY not set, cannot call LLM API');
      return null;
    }

    console.log(' Calling Inception LLM API...');

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30000);  // 30 second timeout

    let response;
    try {
      const https = require('https');
      const payload = JSON.stringify({
        model: 'mercury-2',
        messages: [{ role: 'user', content: prompt }],
        reasoning_effort: 'instant'
      });

      response = await new Promise((resolve, reject) => {
        const req = https.request(
          'https://api.inceptionlabs.ai/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Length': Buffer.byteLength(payload)
            },
            family: 4
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
            });
          }
        );

        req.on('error', reject);
        controller.signal.addEventListener('abort', () => {
          req.destroy(new Error('Request aborted'));
        });

        req.write(payload);
        req.end();
      });
    } catch (error) {
      console.error('⚠️ LLM API request failed:', error.message);
      return null;
    }

    let data;
    try {
      data = JSON.parse(response.body);
    } catch (error) {
      console.error('⚠️ Failed to parse LLM response:', error.message);
      return null;
    }

    if (!response.ok) {
      console.error('❌ LLM API error:', data.error || data);
      return null;
    }

    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error('❌ LLM response missing choices:', data);
      return null;
    }

    const content = data.choices[0].message.content;

    // Strip markdown code fences if present
    const cleanContent = content
      .replace(/^```(?:json)?\s*\n?/, '')      // Remove opening ```json
      .replace(/\n?```\s*$/, '')                // Remove closing ```
      .trim();

    return cleanContent;
  }

  /**
   * Full analysis pipeline
   */
  async analyze(logs, deployment = null, namespace = 'default') {
    console.log('Starting two-stage analysis...');

    // Stage 1: Diagnose (with optional Prometheus metrics if deployment provided)
    const diagnosis = await this.diagnose(logs, deployment, namespace);

    // If diagnosis confidence is too low, skip planning
    if (diagnosis.confidence < 0.4) {
      console.log('⚠️ Diagnosis confidence too low, taking no action');
      return {
        action: 'log_only',
        reasoning: `Low diagnosis confidence (${diagnosis.confidence})`,
        confidence: diagnosis.confidence,
        diagnosis: diagnosis,
        plan: null
      };
    }

    // Stage 2: Plan
    const plan = await this.plan(diagnosis, logs);

    // Fallback if plan() returns null
    if (!plan) {
      console.log('⚠️ Plan stage failed, falling back to log_only');
      return {
        action: 'log_only',
        reasoning: 'Plan stage failed to generate action',
        confidence: 0.1,
        diagnosis: diagnosis,
        plan: null
      };
    }

    return {
      action: plan.recommended_action,
      reasoning: plan.reasoning,
      confidence: plan.confidence,
      diagnosis: diagnosis,
      plan: plan
    };
  }
}

module.exports = TwoStageLLM;