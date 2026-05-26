/**
 * ApprovalManager - Manages approval state machine and lifecycle
 * Stores approval requests in JSONL format for audit trail
 *
 * Approval states: pending, approved, rejected, expired
 * Approval timeout: 5 minutes by default
 */

const fs = require('fs').promises;
const path = require('path');

class ApprovalManager {
  constructor(logPath = '/agent/audit/approvals.jsonl', timeoutMs = 300000) {
    this.logPath = logPath;
    this.timeoutMs = timeoutMs;  // 5 minutes by default
    this.approvals = new Map();  // In-memory cache for quick lookups
  }

  /**
   * Initialize the approval log (create directory if needed)
   * Also load any existing approvals from disk
   */
  async initialize() {
    try {
      const dir = path.dirname(this.logPath);
      await fs.mkdir(dir, { recursive: true });
      console.log(`Approval log initialized at ${this.logPath}`);

      // Load existing approvals from JSONL file
      await this.loadApprovalsFromDisk();
    } catch (error) {
      console.error(`Failed to initialize approval log: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load all approvals from the JSONL file into memory
   * This ensures approvals persist across pod restarts
   */
  async loadApprovalsFromDisk() {
    try {
      const data = await fs.readFile(this.logPath, 'utf8');
      if (!data.trim()) {
        console.log(`No existing approvals to load`);
        return;
      }

      const lines = data.split('\n').filter(line => line.trim());
      let loaded = 0;
      let updated = 0;

      for (const line of lines) {
        try {
          const approval = JSON.parse(line);
          if (approval.id) {
            // Store or update the approval (latest entry wins if duplicated)
            this.approvals.set(approval.id, approval);

            if (approval.updated) {
              updated++;
            } else {
              loaded++;
            }
          }
        } catch (e) {
          // Skip malformed lines
        }
      }

      console.log(`Loaded ${loaded} approvals from disk (${updated} updates)`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
        console.error(`Failed to load approvals from disk: ${error.message}`);
      }
      // ENOENT is OK - file just doesn't exist yet
    }
  }

  /**
   * Generate a unique approval ID
   * Format: approval-[timestamp]-[random]
   */
  generateApprovalId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `approval-${timestamp}-${random}`;
  }

  /**
   * Create a new approval request
   * Returns the approval ID
   */
  async createApprovalRequest(actionType, deployment, parameters, confidence) {
    const approvalId = this.generateApprovalId();
    const now = new Date();

    const request = {
      id: approvalId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.timeoutMs).toISOString(),
      status: 'pending',
      action: actionType,
      actionParams: parameters,
      deployment: deployment,
      confidence: confidence,
      respondedBy: null,
      respondedAt: null,
      reason: null,  // For rejection reason
      result: null   // Execution result after approval
    };

    // Store in memory
    this.approvals.set(approvalId, request);

    // Append to JSONL audit log
    try {
      await fs.appendFile(
        this.logPath,
        JSON.stringify(request) + '\n'
      );
      console.log(`Approval request created: ${approvalId}`);
    } catch (error) {
      console.error(`Failed to write approval to log: ${error.message}`);
      throw error;
    }

    return approvalId;
  }

  /**
   * Get an approval request by ID
   */
  getApprovalRequest(approvalId) {
    return this.approvals.get(approvalId) || null;
  }

  /**
   * Approve an action
   */
  async approveAction(approvalId, userId) {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      console.error(`Approval not found: ${approvalId}`);
      return null;
    }

    if (approval.status !== 'pending') {
      console.warn(`Approval already ${approval.status}: ${approvalId}`);
      return approval;
    }

    const now = new Date();
    approval.status = 'approved';
    approval.respondedBy = userId;
    approval.respondedAt = now.toISOString();

    // Update in JSONL (append updated state)
    try {
      await fs.appendFile(
        this.logPath,
        JSON.stringify({
          ...approval,
          updated: 'approved'
        }) + '\n'
      );
      console.log(`Approval approved: ${approvalId} by ${userId}`);
    } catch (error) {
      console.error(`Failed to update approval: ${error.message}`);
    }

    return approval;
  }

  /**
   * Reject an action
   */
  async rejectAction(approvalId, userId, reason = '') {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      console.error(`Approval not found: ${approvalId}`);
      return null;
    }

    if (approval.status !== 'pending') {
      console.warn(`Approval already ${approval.status}: ${approvalId}`);
      return approval;
    }

    const now = new Date();
    approval.status = 'rejected';
    approval.respondedBy = userId;
    approval.respondedAt = now.toISOString();
    approval.reason = reason || 'User rejected via Slack';

    // Update in JSONL (append updated state)
    try {
      await fs.appendFile(
        this.logPath,
        JSON.stringify({
          ...approval,
          updated: 'rejected'
        }) + '\n'
      );
      console.log(`Approval rejected: ${approvalId} by ${userId}`);
    } catch (error) {
      console.error(`Failed to update approval: ${error.message}`);
    }

    return approval;
  }

  /**
   * Mark an approval as executed after being approved
   */
  async markExecuted(approvalId, executionResult) {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      console.error(`Approval not found: ${approvalId}`);
      return null;
    }

    approval.result = executionResult;
    approval.status = 'executed';

    // Update in JSONL
    try {
      await fs.appendFile(
        this.logPath,
        JSON.stringify({
          ...approval,
          updated: 'executed'
        }) + '\n'
      );
    } catch (error) {
      console.error(`Failed to update approval result: ${error.message}`);
    }

    return approval;
  }

  /**
   * Expire old approvals (> 5 minutes old)
   * Called periodically from main agent loop
   */
  async expireOldApprovals() {
    const now = new Date();
    const expired = [];

    for (const [approvalId, approval] of this.approvals.entries()) {
      if (approval.status !== 'pending') {
        continue;  // Only check pending approvals
      }

      const expiresAt = new Date(approval.expiresAt);
      if (now > expiresAt) {
        expired.push(approvalId);
        approval.status = 'expired';

        try {
          await fs.appendFile(
            this.logPath,
            JSON.stringify({
              ...approval,
              updated: 'expired'
            }) + '\n'
          );
        } catch (error) {
          console.error(`Failed to log expiry: ${error.message}`);
        }
      }
    }

    if (expired.length > 0) {
      console.log(`Expired ${expired.length} approval request(s): ${expired.join(', ')}`);
    }

    return expired;
  }

  /**
   * Get all pending approvals
   */
  getPendingApprovals() {
    const pending = [];
    for (const approval of this.approvals.values()) {
      if (approval.status === 'pending') {
        pending.push(approval);
      }
    }
    return pending;
  }

  /**
   * Get approval stats for monitoring
   */
  getStats() {
    const stats = {
      total: this.approvals.size,
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
      executed: 0
    };

    for (const approval of this.approvals.values()) {
      stats[approval.status] = (stats[approval.status] || 0) + 1;
    }

    return stats;
  }
}

module.exports = ApprovalManager;
