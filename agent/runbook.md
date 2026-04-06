# Auto-Ops Runbook

## Known failure patterns and responses

### Pattern: 5xx error spike
- **Symptoms**: Multiple 500-level errors in logs, error rate >10 per minute
- **Root cause**: Memory leak, bad deploy, code exception
- **Action**: restart
- **Confidence threshold**: 0.7
- **Notes**: If recurs within 10 minutes, escalate to rollback

### Pattern: High latency
- **Symptoms**: Request duration >2s sustained over 30 seconds
- **Root cause**: CPU saturation, external dependency slow
- **Action**: scale (increase replicas to 3)
- **Confidence threshold**: 0.6

### Pattern: Crash loop
- **Symptoms**: Pod restarting repeatedly, startup errors
- **Root cause**: Bad image, missing config, port conflict
- **Action**: rollback
- **Confidence threshold**: 0.8
- **Notes**: Do NOT restart - will make worse

### Pattern: Low confidence anomaly
- **Symptoms**: Unusual logs but no clear pattern
- **Action**: log_only
- **Confidence threshold**: <0.5

### Pattern: Database timeout spike (DB_TIMEOUT)
- **Symptoms**: "DB_TIMEOUT" error code appearing multiple times, database connection errors
- **Root cause**: Connection pool exhausted, database unreachable, query timeout
- **Action**: restart
- **Confidence threshold**: 0.75
- **Notes**: If persists after 2 restarts, escalate to rollback

### Pattern: OOMKilled (memory pressure)
- **Symptoms**: Pod killed repeatedly, "OOMKilled" in pod status, memory pressure events
- **Root cause**: Memory leak in application, insufficient resource limits set
- **Action**: scale (increase replicas to 3 to distribute load) + restart
- **Confidence threshold**: 0.85
- **Notes**: Review memory limits in deployment if recurring

### Pattern: Config or Secret missing
- **Symptoms**: Pod startup fails with "failed to mount" errors, ConfigMap or sealed-secret errors
- **Root cause**: Sealed secret not unlocked, ConfigMap deleted, wrong namespace reference
- **Action**: rollback
- **Confidence threshold**: 0.9
- **Notes**: Check sealed-secret controller status before retrying

### Pattern: Deployment image pull failed
- **Symptoms**: Pod in ImagePullBackOff status, "Failed to pull image" in events
- **Root cause**: Bad image tag, registry authentication failure, image doesn't exist
- **Action**: rollback
- **Confidence threshold**: 0.85
- **Notes**: Verify image tag and registry credentials

### Pattern: PVC/storage unavailable
- **Symptoms**: Pod cannot mount volume, "failed to attach volume" errors
- **Root cause**: PVC not bound, storage node failure, insufficient disk space
- **Action**: rollback (for critical services)
- **Confidence threshold**: 0.8
- **Notes**: Check PVC status with kubectl describe pvc

### Pattern: Normal operation
- **Symptoms**: No errors, healthy request patterns, all endpoints responding normally
- **Action**: none
- **Confidence threshold**: >0.9