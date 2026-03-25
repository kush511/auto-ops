async function analyzeLogs(logs) {
  const prompt = `
You are a seasoned DevOps expert specializing in system monitoring and incident response.

Analyze the following application logs for anomalies, errors, warnings, and performance degradation.

Return a JSON object with:
{
  "issue": "Clear, concise description of the detected problem (or 'No critical issues' if logs are clean)",
  "severity": "low | medium | high",
  "suggested_action": "Specific, actionable remediation step (e.g., 'Restart service', 'Check disk space', 'Review database connection pool')",
  "confidence": 0.0 to 1.0,
  "affected_services": ["service1", "service2"],
  "patterns": ["pattern1", "pattern2"]
}

Severity Guide:
- high: Service down, critical errors, database connection failures, repeated timeouts
- medium: Performance degradation, memory spikes, multiple warnings, partial failures
- low: Single warnings, non-critical exceptions, info-level anomalies

Consider error patterns, frequency spikes, and timestamps when evaluating severity.

Logs:
${logs}
`;

  const response = await fetch('https://api.inceptionlabs.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.INCEPTION_API_KEY}`
    },
    body: JSON.stringify({
      model: 'mercury-2',
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: 'instant'
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

module.exports = analyzeLogs;
