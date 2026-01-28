import {
  handlePage,
  handleApi,
  handleResolve,
  handleStream,
  handleSegment
} from './handlers.js';
import { MetricsCollector, withMetrics } from './metrics.js';

// Global metrics instance
let metricsInstance = null;

export default {
  async fetch(request, env) {
    try {
      // Initialize metrics on first request
      if (!metricsInstance) {
        metricsInstance = new MetricsCollector(env);
      }

      const url = new URL(request.url);
      const params = url.searchParams;
      const mode = params.get('mode');

      // Health check endpoint
      if (mode === 'health') {
        return Response.json(
          {
            status: 'ok',
            timestamp: new Date().toISOString(),
            metrics: metricsInstance.getSummary()
          },
          { status: 200 }
        );
      }

      // Metrics summary endpoint
      if (mode === 'metrics') {
        return Response.json(
          {
            timestamp: new Date().toISOString(),
            ...metricsInstance.getSummary()
          },
          { status: 200 }
        );
      }

      const startTime = performance.now();
      let response;

      try {
        if (mode === 'page') response = await handlePage(request, params);
        else if (mode === 'api') response = await handleApi(request, params);
        else if (mode === 'resolve') response = await handleResolve(request, params, env, metricsInstance);
        else if (mode === 'stream') response = await handleStream(request, params, env, metricsInstance);
        else if (mode === 'segment') response = await handleSegment(request, params);
        else {
          metricsInstance.trackError('unknown', 'invalid_mode');
          return Response.json(
            {
              error: 'Invalid or missing mode',
              allowed: ['page', 'api', 'resolve', 'stream', 'segment', 'health', 'metrics']
            },
            { status: 400 }
          );
        }

        // Track metrics
        metricsInstance.trackRequest(mode);
        const duration = Math.round(performance.now() - startTime);
        metricsInstance.trackResponseTime(mode, duration);

        return response;
      } catch (err) {
        metricsInstance.trackError(mode, err?.message || 'unknown');
        throw err;
      }
    } catch (err) {
      return Response.json(
        { error: err?.message || 'Internal error' },
        { status: 500 }
      );
    }
  }
};
