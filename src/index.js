import {
  handlePage,
  handleApi,
  handleResolve,
  handleStream,
  handleSegment
} from './handlers.js';
import { MetricsCollector, withMetrics } from './metrics.js';

export default {
  async fetch(request, env) {
    try {
      // Initialize and load metrics for each request
      const metricsInstance = new MetricsCollector(env);
      await metricsInstance.load();

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

      // Clear metrics endpoint (admin)
      if (mode === 'metrics-reset') {
        const key = params.get('key');
        if (key === env.ADMIN_KEY || !env.ADMIN_KEY) {
          await env.SHARE_KV.delete('metrics:current');
          metricsInstance.metrics = {
            requests: {},
            errors: {},
            cacheHits: 0,
            cacheMisses: 0,
            responseTimes: {},
            upstreamErrors: 0,
            kvOperations: { reads: 0, writes: 0, failures: 0 }
          };
          return Response.json(
            { status: 'metrics cleared', timestamp: new Date().toISOString() },
            { status: 200 }
          );
        }
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
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
              allowed: ['page', 'api', 'resolve', 'stream', 'segment', 'health', 'metrics', 'metrics-reset']
            },
            { status: 400 }
          );
        }

        // Track metrics
        metricsInstance.trackRequest(mode);
        const duration = Math.round(performance.now() - startTime);
        metricsInstance.trackResponseTime(mode, duration);

        // Save metrics to KV before returning
        await metricsInstance.flush();

        return response;
      } catch (err) {
        metricsInstance.trackError(mode, err?.message || 'unknown');
        await metricsInstance.flush();
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
