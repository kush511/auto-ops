async function analyzeLogs(logs) {
  if (!process.env.INCEPTION_API_KEY) {
    console.log('ℹ️ INCEPTION_API_KEY not set, skipping external AI analysis');
    return null;
  }

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

CRITICAL RULES:
1. ONLY report patterns that are EXPLICITLY visible in the logs
2. DO NOT make up or infer latency if you don't see actual delay measurements
3. DO NOT hallucinate issues - if logs are clean/informational only, severity = "low"
4. High latency MUST include explicit timing data (e.g., "delay: 2500ms" or "latency detected")
5. Do NOT infer issues from INFO-level logs alone

Severity Guide:
- high: Actual errors, crashes, timeouts (with proof in logs), repeated failures, EXPLICIT high latency measurements (>2s)
- medium: Multiple warnings, some performance issues with evidence, occasional errors
- low: INFO-level logs, single warnings, no errors or warnings present

LOGS ANALYSIS RULES:
- Look for ERROR or WARN keywords for actual issues
- Look for explicit millisecond values (e.g., "delay > 2000", "latency detected") for performance issues
- INFO-level logs about normal requests = do NOT escalate severity unless they contain error indicators
- Health checks = normal operation, not a problem unless accompanied by errors

Logs:
${logs}
`;

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch('https://api.inceptionlabs.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INCEPTION_API_KEY}`
      },
      body: JSON.stringify({
        model: 'mercury-2',
        messages: [{ role: 'user', content: prompt }],
        reasoning_effort: 'instant'
      }),
      signal: controller.signal
    });
  } catch (error) {
    console.error('⚠️ External AI request failed, using fallback:', error.message);
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.error('⚠️ Failed to parse AI response, using fallback:', error.message);
    return null;
  }

  if (!response.ok) {
    console.error("❌ AI API error:", data.error || data);
    return null;
  }

  if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
    console.error("❌ AI response missing choices array:", data);
    return null;
  }

  const content = data.choices[0].message.content;

  // Strip markdown code fences if present (handle various whitespace)
  const cleanContent = content
    .replace(/^```(?:json)?\s*\n?/, '')  // Remove opening ```json with optional whitespace
    .replace(/\n?```\s*$/, '')            // Remove closing ``` with optional whitespace
    .trim();

  try {
    return JSON.parse(cleanContent);
  } catch (err) {
    console.log("⚠️ AI returned invalid JSON:", content);
    return null;
  }
}

module.exports = analyzeLogs;
