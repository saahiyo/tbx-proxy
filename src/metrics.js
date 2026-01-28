/**
 * Metrics tracking for API requests, errors, cache performance, and response times
 */

export class MetricsCollector {
  constructor(env) {
    this.env = env;
    this.metrics = {
      requests: {},
      errors: {},
      cacheHits: 0,
      cacheMisses: 0,
      responseTimes: {},
      upstreamErrors: 0,
      kvOperations: {
        reads: 0,
        writes: 0,
        failures: 0
      }
    };
  }

  /**
   * Track request by mode
   */
  trackRequest(mode) {
    this.metrics.requests[mode] = (this.metrics.requests[mode] || 0) + 1;
  }

  /**
   * Track errors by mode
   */
  trackError(mode, error) {
    const key = `${mode}:${error || 'unknown'}`;
    this.metrics.errors[key] = (this.metrics.errors[key] || 0) + 1;
  }

  /**
   * Track cache hit/miss
   */
  trackCache(hit) {
    if (hit) {
      this.metrics.cacheHits++;
    } else {
      this.metrics.cacheMisses++;
    }
  }

  /**
   * Track response time for a mode
   */
  trackResponseTime(mode, duration) {
    if (!this.metrics.responseTimes[mode]) {
      this.metrics.responseTimes[mode] = {
        total: 0,
        count: 0,
        min: Infinity,
        max: 0
      };
    }
    const rt = this.metrics.responseTimes[mode];
    rt.total += duration;
    rt.count++;
    rt.min = Math.min(rt.min, duration);
    rt.max = Math.max(rt.max, duration);
  }

  /**
   * Track KV operations
   */
  trackKvOperation(type, success = true) {
    if (type === 'read') {
      this.metrics.kvOperations.reads++;
    } else if (type === 'write') {
      this.metrics.kvOperations.writes++;
    }
    if (!success) {
      this.metrics.kvOperations.failures++;
    }
  }

  /**
   * Track upstream API errors
   */
  trackUpstreamError() {
    this.metrics.upstreamErrors++;
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const responseTimes = {};
    Object.entries(this.metrics.responseTimes).forEach(([mode, data]) => {
      responseTimes[mode] = {
        average: Math.round(data.total / data.count),
        min: data.min,
        max: data.max,
        count: data.count
      };
    });

    const totalRequests = Object.values(this.metrics.requests).reduce(
      (a, b) => a + b,
      0
    );
    const totalErrors = Object.values(this.metrics.errors).reduce(
      (a, b) => a + b,
      0
    );
    const totalCacheOps =
      this.metrics.cacheHits + this.metrics.cacheMisses;
    const cacheHitRate =
      totalCacheOps > 0
        ? ((this.metrics.cacheHits / totalCacheOps) * 100).toFixed(2)
        : 'N/A';

    return {
      totalRequests,
      requestsByMode: this.metrics.requests,
      totalErrors,
      errorsByType: this.metrics.errors,
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      cacheHitRate: `${cacheHitRate}%`,
      responseTimes,
      kvOperations: this.metrics.kvOperations,
      upstreamErrors: this.metrics.upstreamErrors
    };
  }

  /**
   * Send metrics to external service (optional)
   * Configure endpoint in wrangler.toml: METRICS_ENDPOINT
   */
  async flush() {
    if (!this.env.METRICS_ENDPOINT) return;

    try {
      await fetch(this.env.METRICS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          metrics: this.getSummary()
        })
      });
    } catch (err) {
      console.error('Failed to flush metrics:', err);
    }
  }
}

/**
 * Middleware to wrap handler execution with metrics tracking
 */
export function withMetrics(metrics, mode) {
  return async (handler, request, ...args) => {
    const startTime = performance.now();
    metrics.trackRequest(mode);

    try {
      const response = await handler(request, ...args);
      const duration = Math.round(performance.now() - startTime);
      metrics.trackResponseTime(mode, duration);

      return response;
    } catch (err) {
      metrics.trackError(mode, err?.message || 'unknown');
      throw err;
    }
  };
}
