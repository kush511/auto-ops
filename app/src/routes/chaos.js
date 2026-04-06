const express = require('express');
const logger = require('../utils/logger');
const router = express.Router();

// Chaos mode state
let chaosMode = {
  active: false,
  type: null,
  until: null,
  errorRate: 100,  // percentage of requests that error
  delayMs: 3000    // delay in milliseconds
};

// Middleware to apply chaos to all requests
const chaosMiddleware = (req, res, next) => {
  if (req.path.startsWith('/chaos/')) {
    next();
    return;
  }

  // Check if chaos mode is active and not expired
  if (chaosMode.active && chaosMode.until > Date.now()) {
    
    if (chaosMode.type === 'errors') {
      // Randomly return error based on rate
      const shouldError = Math.random() * 100 < chaosMode.errorRate;
      if (shouldError) {
        logger.error('Repeated simulated database failures (DB_TIMEOUT) on the backend service', {
          errorCode: 'DB_TIMEOUT',
          chaos: true,
          endpoint: req.originalUrl,
          method: req.method
        });
        return res.status(500).json({ 
          error: 'Chaos-induced 500 error',
          chaos: true,
          message: 'This error was intentionally triggered for demo purposes'
        });
      }
    }
    
    if (chaosMode.type === 'latency') {
      logger.warn('High response latency detected', {
        delay: chaosMode.delayMs,
        chaos: true,
        endpoint: req.originalUrl,
        method: req.method
      });
      // Add artificial delay
      setTimeout(next, chaosMode.delayMs);
      return;
    }
  }
  
  next();
};

// Endpoint to activate error chaos
router.get('/chaos/errors', (req, res) => {
  const duration = parseInt(req.query.duration) || 30;
  const rate = parseInt(req.query.rate) || 100;
  
  chaosMode = {
    active: true,
    type: 'errors',
    until: Date.now() + (duration * 1000),
    errorRate: Math.min(100, Math.max(0, rate)), // clamp between 0-100
    delayMs: chaosMode.delayMs
  };

  logger.warn('Chaos mode activated: errors', {
    duration_seconds: duration,
    error_rate: chaosMode.errorRate,
    chaos: true
  });

  // Emit explicit error patterns immediately so AI can detect issue even with low traffic
  for (let i = 0; i < 3; i++) {
    logger.error('Repeated simulated database failures (DB_TIMEOUT) on the backend service', {
      errorCode: 'DB_TIMEOUT',
      chaos: true,
      sample: i + 1
    });
  }
  
  // Auto-expire after duration
  setTimeout(() => {
    if (chaosMode.type === 'errors' && chaosMode.until <= Date.now()) {
      chaosMode.active = false;
      logger.info('Chaos mode: Errors ended automatically', { chaos: true });
    }
  }, duration * 1000);
  
  res.json({
    status: 'chaos_activated',
    type: 'errors',
    message: `Will return ${rate}% 500 errors for ${duration} seconds`,
    ends_at: new Date(chaosMode.until).toISOString()
  });
});

// Endpoint to activate latency chaos
router.get('/chaos/latency', (req, res) => {
  const duration = parseInt(req.query.duration) || 30;
  const delay = parseInt(req.query.delay) || 3000;
  
  chaosMode = {
    active: true,
    type: 'latency',
    until: Date.now() + (duration * 1000),
    errorRate: chaosMode.errorRate,
    delayMs: Math.min(10000, Math.max(100, delay)) // between 100ms-10s
  };

  logger.warn('Chaos mode activated: latency', {
    duration_seconds: duration,
    delay: chaosMode.delayMs,
    chaos: true
  });
  logger.warn('High response latency detected', {
    delay: chaosMode.delayMs,
    chaos: true,
    source: 'chaos_activation'
  });
  
  setTimeout(() => {
    if (chaosMode.type === 'latency' && chaosMode.until <= Date.now()) {
      chaosMode.active = false;
      logger.info('Chaos mode: Latency ended automatically', { chaos: true });
    }
  }, duration * 1000);
  
  res.json({
    status: 'chaos_activated',
    type: 'latency',
    message: `Will delay responses by ${delay}ms for ${duration} seconds`,
    ends_at: new Date(chaosMode.until).toISOString()
  });
});

// Endpoint to stop all chaos immediately
router.get('/chaos/stop', (req, res) => {
  chaosMode.active = false;
  logger.info('Chaos mode manually deactivated', { chaos: true });
  res.json({
    status: 'chaos_deactivated',
    message: 'Normal operation restored'
  });
});

// Endpoint to check chaos status
router.get('/chaos/status', (req, res) => {
  const remaining = chaosMode.active ? Math.max(0, (chaosMode.until - Date.now()) / 1000) : 0;
  
  res.json({
    active: chaosMode.active,
    type: chaosMode.type,
    remaining_seconds: remaining,
    config: {
      error_rate: chaosMode.errorRate,
      delay_ms: chaosMode.delayMs
    }
  });
});

module.exports = { router, chaosMiddleware };