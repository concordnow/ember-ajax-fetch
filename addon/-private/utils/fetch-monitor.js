import fetch from 'fetch';

// Default configuration
const DEFAULT_CONFIG = {
  // Enable console logging (set to false in production if too noisy)
  enableConsoleLogging: false,
  // Minimum duration to log (ms) - avoid logging very fast requests
  minDurationToLog: 100,
  // Large response threshold (bytes) - 5MB
  largeResponseThreshold: 5 * 1024 * 1024,
  // Slow request threshold (ms) - 10 seconds
  slowRequestThreshold: 10000,
  // Known infrastructure timeout thresholds (ms) - NOT browser timeouts!
  // These are common timeouts from proxies, load balancers, API gateways, CDNs
  // Adjust these based on your actual infrastructure (AWS ALB: 60s, API Gateway: 30s, etc.)
  infrastructureTimeoutThresholds: [30000, 60000, 90000, 120000], // 30s, 60s, 90s, 120s
  // Tolerance for timeout detection (±2 seconds)
  timeoutTolerance: 2000,
  // Report warnings to Sentry (set to false to only report actual errors)
  reportWarnings: false,
  // Only report warnings for requests slower than this (ms) - avoids noise from normal requests
  reportWarningsOnlyIfSlowerThan: 20000, // 20 seconds
  // Immediate failure threshold (ms) - for detecting CORS/blocked requests
  immediateFailureThreshold: 100,
  // Connection drop detection thresholds (ms)
  connectionDropThresholds: {
    fastHeaders: 1000, // Headers received quickly
    slowTotal: 5000, // But total request took long
  },
};

/**
 * Safely import Sentry - returns null if not available
 * @returns {Object|null} Sentry instance or null
 */
function getSentry() {
  try {
    // Dynamic import to handle cases where @sentry/ember is not installed
    const Sentry = require('@sentry/ember');
    return Sentry.default || Sentry;
  } catch (e) {
    // Sentry not available - silently continue
    return null;
  }
}

/**
 * Calculate total request time from timings
 * @param {Object} timings - Timing object
 * @returns {number} Total time in milliseconds
 */
function calculateTotalTime(timings) {
  return timings.requestEnd 
    ? timings.requestEnd - timings.requestStart
    : performance.now() - timings.requestStart;
}

/**
 * Calculate time to headers from timings
 * @param {Object} timings - Timing object
 * @returns {number|null} Time to headers in milliseconds, or null if not available
 */
function calculateTimeToHeaders(timings) {
  return timings.headerReceived 
    ? timings.headerReceived - timings.requestStart
    : null;
}

/**
 * Determine if request should be logged based on duration and config
 * @param {number} totalTime - Total request time in milliseconds
 * @param {Object} config - Configuration object
 * @returns {boolean} Whether to log the request
 */
function shouldLogRequest(totalTime, config) {
  return config.enableConsoleLogging && totalTime > config.minDurationToLog;
}

/**
 * Check if a value is near a threshold within tolerance
 * @param {number} value - Value to check
 * @param {number} threshold - Threshold to compare against
 * @param {number} tolerance - Tolerance range
 * @returns {boolean} Whether value is near threshold
 */
function isNearThreshold(value, threshold, tolerance) {
  return Math.abs(value - threshold) < tolerance;
}

// Configuration validation rules
const CONFIG_VALIDATION = {
  largeResponseThreshold: { default: 5 * 1024 * 1024, validate: v => v > 0 },
  slowRequestThreshold: { default: 10000, validate: v => v > 0 },
  minDurationToLog: { default: 100, validate: v => v >= 0 },
  infrastructureTimeoutThresholds: { 
    default: [30000, 60000, 90000, 120000], 
    validate: v => Array.isArray(v) && v.length > 0 
  },
  reportWarningsOnlyIfSlowerThan: { default: 20000, validate: v => v > 0 },
  immediateFailureThreshold: { default: 100, validate: v => v >= 0 },
  connectionDropThresholds: {
    default: { fastHeaders: 1000, slowTotal: 5000 },
    validate: v => v && typeof v === 'object' && v.fastHeaders > 0 && v.slowTotal > 0
  }
};

/**
 * Validates configuration object
 * @param {Object} config - Configuration object to validate
 */
function validateConfig(config) {
  Object.entries(CONFIG_VALIDATION).forEach(([key, rule]) => {
    if (!rule.validate(config[key])) {
      config[key] = rule.default;
    }
  });
}

/**
 * Get network information with robust feature detection
 * @returns {Object|null} Network information or null if unavailable
 */
function getNetworkInfo() {
  try {
    const connection =
      navigator.connection ||
      navigator.mozConnection ||
      navigator.webkitConnection;

    // Check if connection API is actually available and has the properties we need
    if (!connection || typeof connection.effectiveType === 'undefined') {
      return null;
    }

    return {
      effectiveType: connection.effectiveType || 'unknown', // '4g', '3g', '2g', 'slow-2g'
      downlink: connection.downlink ?? null, // Mbps
      rtt: connection.rtt ?? null, // Round-trip time in ms
      saveData: connection.saveData ?? false, // Data saver enabled
      type: connection.type || 'unknown', // 'wifi', 'cellular', etc.
    };
  } catch (error) {
    // Silently fail if network API throws an error
    return null;
  }
}

/**
 * Format bytes to human readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  if (!bytes) return 'unknown';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Check if actual size matches content-length
 * @param {Object} metrics - Metrics object
 * @returns {Object|boolean|null} Size mismatch details or false if no mismatch
 */
function checkSizeMismatch(metrics) {
  if (!metrics.contentLength || !metrics.actualBodySize) {
    return null;
  }

  const expected = parseInt(metrics.contentLength, 10);
  const actual = metrics.actualBodySize;

  if (expected === actual) {
    return false;
  }

  return {
    expected: expected,
    actual: actual,
    difference: actual - expected,
    percentDiff: (((actual - expected) / expected) * 100).toFixed(2) + '%',
  };
}

/**
 * Analyze request for warning signs
 * @param {Object} metrics - Metrics object
 * @param {Object} timings - Timings object
 * @param {Object|null} networkInfo - Network information
 * @param {Object} config - Configuration object
 * @returns {Object} Analysis result
 */
function analyzeRequest(metrics, timings, networkInfo, config) {
  const warnings = [];
  const totalTime = calculateTotalTime(timings);

  // Check for large response
  if (
    metrics.actualBodySize &&
    metrics.actualBodySize > config.largeResponseThreshold
  ) {
    warnings.push({
      type: 'large_response',
      message: `Response size (${formatBytes(
        metrics.actualBodySize
      )}) exceeds threshold`,
      severity: 'warning',
    });
  }

  // Check for slow request
  if (totalTime > config.slowRequestThreshold) {
    warnings.push({
      type: 'slow_request',
      message: `Request took ${totalTime.toFixed(0)}ms`,
      severity: 'warning',
    });
  }

  // Check for near-timeout durations
  config.infrastructureTimeoutThresholds.forEach((threshold) => {
    if (isNearThreshold(totalTime, threshold, config.timeoutTolerance)) {
      warnings.push({
        type: 'near_timeout',
        message: `Total time (${totalTime.toFixed(
          0
        )}ms) near timeout threshold (${threshold}ms)`,
        severity: 'warning',
      });
    }
  });

  // Check for size mismatch
  const sizeMismatch = checkSizeMismatch(metrics);
  if (sizeMismatch && Math.abs(sizeMismatch.difference) > 1000) {
    // >1KB difference
    warnings.push({
      type: 'size_mismatch',
      message: `Content-Length mismatch: expected ${sizeMismatch.expected}, got ${sizeMismatch.actual}`,
      severity: 'warning',
    });
  }

  // Check network quality - useful context for debugging production issues
  if (networkInfo && ['2g', 'slow-2g'].includes(networkInfo.effectiveType)) {
    warnings.push({
      type: 'slow_connection',
      message: `User on slow connection: ${networkInfo.effectiveType} (${networkInfo.downlink}Mbps)`,
      severity: 'info',
    });
  }

  return {
    warnings: warnings,
    isHealthy: warnings.length === 0,
  };
}

/**
 * Diagnose fetch-level failure
 * @param {Object} metrics - Metrics object
 * @param {Object} timings - Timings object
 * @param {Object|null} networkInfo - Network information
 * @param {Object} config - Configuration object
 * @returns {Object} Diagnosis result
 */
function diagnoseFetchFailure(metrics, timings, networkInfo, config) {
  const diagnoses = [];
  const totalTime = calculateTotalTime(timings);

  // Check for CORS/blocked by error message
  const errorMessage = (metrics.errorMessage || '').toLowerCase();
  const isCorsError = errorMessage.includes('cors') ||
                      errorMessage.includes('blocked') ||
                      (errorMessage.includes('failed to fetch') && totalTime < 1000); // Failed to fetch within 1s often indicates CORS

  if (isCorsError) {
    diagnoses.push({
      cause: 'cors_or_blocked',
      confidence: 'high',
      evidence: `Request failed with CORS-related error: "${metrics.errorMessage}" (${totalTime.toFixed(0)}ms)`,
      recommendation:
        'Check CORS configuration and browser console for blocked requests',
    });
  }

  // Check for immediate failure (CORS, blocked, etc.) - secondary check by timing
  if (totalTime < config.immediateFailureThreshold && !isCorsError) {
    diagnoses.push({
      cause: 'cors_or_blocked',
      confidence: 'high',
      evidence: `Request failed immediately (${totalTime.toFixed(0)}ms)`,
      recommendation:
        'Check CORS configuration and browser console for blocked requests',
    });
  }

  // Check for infrastructure timeout
  config.infrastructureTimeoutThresholds.forEach((threshold) => {
    if (isNearThreshold(totalTime, threshold, config.timeoutTolerance)) {
      diagnoses.push({
        cause: 'infrastructure_timeout',
        confidence: 'high',
        evidence: `Request failed at ${totalTime.toFixed(
          0
        )}ms, matching infrastructure timeout threshold (${threshold}ms)`,
        recommendation:
          'Check proxy/load balancer/API gateway timeout settings, or optimize backend response time',
      });
    }
  });

  // Check for large response
  if (
    metrics.actualBodySize &&
    metrics.actualBodySize > config.largeResponseThreshold
  ) {
    diagnoses.push({
      cause: 'large_response',
      confidence: 'high',
      evidence: `Content-Length (${formatBytes(
        metrics.actualBodySize
      )}) exceeds threshold`,
      recommendation: 'Implement pagination or response size limits',
    });
  }

  // Check for connection drop (fast header, slow/failed total)
  if (timings.headerReceived) {
    const timeToHeaders = calculateTimeToHeaders(timings);
    if (
      timeToHeaders < config.connectionDropThresholds.fastHeaders &&
      totalTime > config.connectionDropThresholds.slowTotal
    ) {
      diagnoses.push({
        cause: 'connection_drop',
        confidence: 'medium',
        evidence: `Headers received quickly (${timeToHeaders.toFixed(
          0
        )}ms) but request failed after ${totalTime.toFixed(0)}ms`,
        recommendation: 'Implement retry logic with exponential backoff',
      });
    }
  }

  // Check network quality
  if (
    networkInfo &&
    ['2g', 'slow-2g', '3g'].includes(networkInfo.effectiveType)
  ) {
    diagnoses.push({
      cause: 'slow_connection',
      confidence: 'medium',
      evidence: `User on ${networkInfo.effectiveType} connection with ${networkInfo.downlink}Mbps`,
      recommendation:
        'Consider adaptive response sizing based on connection quality',
    });
  }

  // Check for network unavailable
  if (networkInfo && networkInfo.downlink === 0) {
    diagnoses.push({
      cause: 'network_unavailable',
      confidence: 'high',
      evidence: 'Network connection reports 0Mbps downlink',
      recommendation: 'User has no network connectivity',
    });
  }

  // Determine primary cause (highest confidence)
  const sortedDiagnoses = [...diagnoses].sort((a, b) => {
    const confidenceOrder = { high: 3, medium: 2, low: 1 };
    return confidenceOrder[b.confidence] - confidenceOrder[a.confidence];
  });

  return {
    primaryCause: sortedDiagnoses[0]?.cause || 'network_error',
    allDiagnoses: diagnoses,
    summary: generateDiagnosisSummary(diagnoses),
  };
}

/**
 * Generate diagnosis summary
 * @param {Array} diagnoses - Array of diagnosis objects
 * @returns {string} Summary string
 */
function generateDiagnosisSummary(diagnoses) {
  if (diagnoses.length === 0) {
    return 'No clear diagnosis - may be random network issue';
  }

  return diagnoses
    .map((d) => `${d.cause} (${d.confidence} confidence)`)
    .join(', ');
}

/**
 * Build warnings context for Sentry
 * @param {Array} warnings - Array of warning objects
 * @returns {Object} Formatted warnings context
 */
function buildWarningsContext(warnings) {
  const warningsContext = {
    warning_count: warnings.length,
  };

  warnings.forEach((warning, index) => {
    const key = `warning_${index + 1}`;
    warningsContext[key] = warning.type;
    warningsContext[`${key}_message`] = warning.message;
    warningsContext[`${key}_severity`] = warning.severity;
  });

  return warningsContext;
}

/**
 * Build diagnosis context for Sentry
 * @param {Object} diagnosis - Diagnosis object
 * @returns {Object} Formatted diagnosis context
 */
function buildDiagnosisContext(diagnosis) {
  const diagnosisContext = {
    primary_cause: diagnosis.primaryCause,
    summary: diagnosis.summary,
    diagnoses_count: diagnosis.allDiagnoses?.length || 0,
  };

  diagnosis.allDiagnoses?.forEach((diag, index) => {
    const key = `diagnosis_${index + 1}`;
    diagnosisContext[key] = `${diag.cause} (${diag.confidence} confidence)`;
    diagnosisContext[`${key}_evidence`] = diag.evidence;
    diagnosisContext[`${key}_recommendation`] = diag.recommendation;
  });

  return diagnosisContext;
}

/**
 * Build HTTP details context for Sentry
 * @param {Object} metrics - Metrics object
 * @param {Object} timings - Timings object
 * @returns {Object} Formatted HTTP details context
 */
function buildHttpDetailsContext(metrics, timings) {
  const totalTime = calculateTotalTime(timings);
  const timeToHeaders = calculateTimeToHeaders(timings);

  return {
    url: metrics.url,
    method: metrics.method,
    status: metrics.status,
    status_text: metrics.statusText,
    content_length: metrics.contentLength,
    content_type: metrics.contentType,
    actual_body_size: metrics.actualBodySize,
    body_size_formatted: formatBytes(metrics.actualBodySize),
    request_duration_ms: totalTime,
    time_to_headers_ms: timeToHeaders,
    size_mismatch: checkSizeMismatch(metrics),
  };
}

/**
 * Consolidated Sentry reporting function
 * @param {Object} params - Reporting parameters
 * @param {string} params.level - Sentry level ('warning', 'error', etc.)
 * @param {string} params.message - Message to report
 * @param {Error} [params.error] - Error object (optional)
 * @param {Object} [params.metrics] - Metrics object (optional)
 * @param {Object} [params.timings] - Timings object (optional)
 * @param {Object} [params.networkInfo] - Network information (optional)
 * @param {Object} [params.analysis] - Analysis result with warnings (optional)
 * @param {Object} [params.diagnosis] - Diagnosis result (optional)
 * @param {Object} [params.requestOptions] - Request options (optional)
 * @param {string} [params.url] - Request URL (optional)
 * @param {Object} [params.response] - Response object (optional)
 */
function reportToSentry({
  level,
  message,
  error,
  metrics,
  timings,
  networkInfo,
  analysis,
  diagnosis,
  requestOptions,
  url,
  response
}) {
  const Sentry = getSentry();
  if (!Sentry) return;

  try {
    Sentry.withScope((scope) => {
      // Set basic tags
      if (metrics) {
        scope.setTag('http_status', metrics.status || 'none');
        scope.setTag('fetch_phase', metrics.errorPhase);
        scope.setTag('error_type', metrics.errorType);
      }

      if (diagnosis) {
        scope.setTag('diagnosed_cause', diagnosis.primaryCause);
      }

      if (analysis) {
        scope.setTag('has_warnings', true);
        scope.setTag('warning_count', analysis.warnings.length);
      }

      // Set fingerprint for grouping
      const fingerprint = ['fetch-monitor'];
      if (url) fingerprint.push(url);
      if (metrics?.status) fingerprint.push(metrics.status.toString());
      if (level) fingerprint.push(level);
      scope.setFingerprint(fingerprint);

      // Add contexts
      if (metrics && timings) {
        scope.setContext('http_details', buildHttpDetailsContext(metrics, timings));
      }

      if (timings) {
        scope.setContext('timing', {
          request_start: new Date(timings.requestStartTimestamp).toISOString(),
          total_time_ms: calculateTotalTime(timings),
        });
      }

      if (networkInfo) {
        scope.setContext('network', networkInfo);
      }

      if (diagnosis) {
        scope.setContext('diagnosis', buildDiagnosisContext(diagnosis));
        scope.setExtra('diagnosis_details', diagnosis.allDiagnoses);
      }

      if (analysis && analysis.warnings.length > 0) {
        scope.setContext('warnings', buildWarningsContext(analysis.warnings));
        scope.setExtra('warnings_details', analysis.warnings);
      }

      if (requestOptions) {
        scope.setContext('request_headers', {
          'content-type': requestOptions.headers?.['Content-Type'] || 'none',
        });
      }

      if (response) {
        scope.setContext('response_details', {
          status: response.status,
          status_text: response.statusText,
          content_type: response.headers?.get?.('content-type') || 'unknown',
        });
      }

      if (metrics) {
        scope.setExtra('error_details', {
          message: metrics.errorMessage,
          type: metrics.errorType,
          phase: metrics.errorPhase,
          possible_cause: metrics.possibleCause,
        });
      }

      // Capture message or exception
      if (error) {
        Sentry.captureException(error);
      } else {
        Sentry.captureMessage(message, { level });
      }
    });
  } catch (sentryError) {
    console.warn('[Fetch Monitor] Failed to report to Sentry:', sentryError);
  }
}

/**
 * Report HTTP error to Sentry (4xx, 5xx responses)
 * @param {Error} error - Error object
 * @param {Object} response - Response object with status, headers, etc
 * @param {Object} requestOptions - Request options
 * @param {string} url - Request URL
 * @param {Object|null} analysis - Analysis result with warnings (optional)
 */
function reportHttpErrorToSentry(error, response, requestOptions, url, analysis = null) {
  reportToSentry({
    level: 'error',
    message: 'HTTP error occurred',
    error,
    response,
    requestOptions,
    url,
    analysis,
  });
}

/**
 * Log and report error to Sentry
 * @param {string} errorType - Type of error
 * @param {Error} error - Error object
 * @param {Object} metrics - Metrics object
 * @param {Object} timings - Timings object
 * @param {Object|null} networkInfo - Network information
 * @param {Object|null} diagnosis - Diagnosis result
 * @param {Object|null} analysis - Analysis result with warnings
 */
function logAndReportError(
  errorType,
  error,
  metrics,
  timings,
  networkInfo,
  diagnosis = null,
  analysis = null
) {
  reportToSentry({
    level: 'error',
    message: `Fetch error: ${errorType}`,
    error,
    metrics,
    timings,
    networkInfo,
    diagnosis,
    analysis,
  });
}

/**
 * Initialize request tracking objects
 * @param {string} url - Request URL
 * @param {Object} options - Request options
 * @param {Object} config - Configuration object
 * @returns {Object} Initialized tracking objects
 */
function initializeRequest(url, options, config) {
  const requestUrl = typeof url === 'string' ? url : url.url;
  const method = options.method || 'GET';

  const timings = {
    requestStart: performance.now(),
    requestStartTimestamp: Date.now(),
    headerReceived: null,
    requestEnd: null,
  };

  const metrics = {
    url: requestUrl,
    method: method,
    status: null,
    statusText: null,
    contentLength: null,
    contentType: null,
    actualBodySize: null,
    errorOccurred: false,
    errorPhase: null,
    errorMessage: null,
    errorType: null,
    possibleCause: null,
  };

  return { timings, metrics, requestUrl, method };
}

/**
 * Handle successful request completion
 * @param {Response} response - Fetch response
 * @param {Object} metrics - Metrics object
 * @param {Object} timings - Timings object
 * @param {Object} config - Configuration object
 * @param {Object|null} networkInfo - Network information
 * @returns {Response} The response object
 */
function handleRequestSuccess(response, metrics, timings, config, networkInfo) {
  timings.headerReceived = performance.now();
  const timeToHeaders = calculateTimeToHeaders(timings);

  // Capture response metadata
  metrics.status = response.status;
  metrics.statusText = response.statusText;
  metrics.contentLength = response.headers.get('content-length');
  metrics.contentType = response.headers.get('content-type');

  // Get actual body size from Content-Length header if available
  if (metrics.contentLength) {
    metrics.actualBodySize = parseInt(metrics.contentLength, 10);
  }

  // Mark end time for analysis
  timings.requestEnd = performance.now();
  const totalTime = calculateTotalTime(timings);

  // Log request completed
  if (shouldLogRequest(totalTime, config)) {
    console.log('[Fetch Monitor] Request completed', {
      url: metrics.url,
      status: metrics.status,
      contentLength: metrics.contentLength,
      bodySize: formatBytes(metrics.actualBodySize),
      contentType: metrics.contentType,
      timeToHeaders: `${timeToHeaders.toFixed(2)}ms`,
      totalTime: `${totalTime.toFixed(2)}ms`,
      timestamp: new Date(timings.requestStartTimestamp).toISOString(),
    });
  }

  return response;
}

/**
 * Handle request failure
 * @param {Error} error - Fetch error
 * @param {Object} metrics - Metrics object
 * @param {Object} timings - Timings object
 * @param {Object} config - Configuration object
 * @param {Object|null} networkInfo - Network information
 * @param {string} requestUrl - Request URL
 * @param {string} method - Request method
 * @throws {Error} Re-throws the original error
 */
function handleRequestFailure(error, metrics, timings, config, networkInfo, requestUrl, method) {
  timings.requestEnd = performance.now();

  metrics.errorOccurred = true;
  metrics.errorPhase = 'fetch_request';
  metrics.errorMessage = error.message;
  metrics.errorType = error.constructor.name;

  const totalTime = calculateTotalTime(timings);

  // Diagnose fetch-level failures
  const diagnosis = diagnoseFetchFailure(metrics, timings, networkInfo, config);
  metrics.possibleCause = diagnosis.primaryCause;

  // Analyze for warnings (to provide additional context in error report)
  const analysis = analyzeRequest(metrics, timings, networkInfo, config);

  console.error('[Fetch Monitor] ⚠️ Fetch request FAILED', {
    url: requestUrl,
    method: method,
    error: error.message,
    errorType: metrics.errorType,
    totalTime: `${totalTime.toFixed(2)}ms`,
    diagnosis: diagnosis,
    warnings: analysis.warnings,
    networkInfo: networkInfo,
    timestamp: new Date(timings.requestStartTimestamp).toISOString(),
  });

  // Report to Sentry with diagnosis and warnings
  logAndReportError(
    'fetch_failure',
    error,
    metrics,
    timings,
    networkInfo,
    diagnosis,
    analysis
  );

  throw error;
}

/**
 * Enhanced fetch with monitoring
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {object} userConfig - Monitoring configuration
 * @returns {Promise<Response>} Fetch response
 */
export async function fetchWithMonitoring(url, options = {}, userConfig = {}) {
  // Merge user config with defaults
  const config = Object.assign({}, DEFAULT_CONFIG, userConfig);

  // Validate configuration
  validateConfig(config);

  // Initialize tracking objects
  const { timings, metrics, requestUrl, method } = initializeRequest(url, options, config);

  // Network information if available
  const networkInfo = getNetworkInfo();

  try {
    // Make the actual fetch call using ember-fetch's fetch
    const response = await fetch(url, options);

    // Handle successful response
    return handleRequestSuccess(response, metrics, timings, config, networkInfo);
  } catch (fetchError) {
    // Handle fetch failure
    handleRequestFailure(fetchError, metrics, timings, config, networkInfo, requestUrl, method);
  }
}

// Export helpers for HTTP error reporting and analysis
export { reportHttpErrorToSentry, analyzeRequest, getNetworkInfo };

