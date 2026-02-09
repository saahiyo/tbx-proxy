import {
  handlePage,
  handleApi,
  handleResolve,
  handleStream,
  handleSegment,
  handleLookup,
  handleAdminOverview,
  handleAdminShares,
  handleAdminShareDetail,
  handleAdminFiles,
  handleAdminFileDetail,
  handleAdminThumbnails,
  handleAdminAnalyticsProcessed,
  handleAdminKvEntry,
  handleAdminKvStats
} from './handlers.js';
import { MetricsCollector } from './metrics.js';
import { CORS_HEADERS, withCors, errorJson } from './utils.js';

function isAdminAuthorized(url, request, env) {
  const key = url.searchParams.get('key') || request.headers.get('x-admin-key');
  return !env.ADMIN_KEY || key === env.ADMIN_KEY;
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    try {
      // Initialize and load metrics for each request
      const metricsInstance = new MetricsCollector(env);
      await metricsInstance.load();

      const url = new URL(request.url);
      const params = url.searchParams;
      const mode = params.get('mode');

      // Admin routes (path-based)
      if (url.pathname.startsWith('/admin')) {
        if (!isAdminAuthorized(url, request, env)) {
          return withCors(errorJson(401, 'Unauthorized', 'unauthorized'));
        }

        const startTime = performance.now();
        let response;

        try {
          if (url.pathname === '/admin/overview') {
            response = await handleAdminOverview(request, params, env);
          } else if (url.pathname === '/admin/shares') {
            response = await handleAdminShares(request, params, env);
          } else if (url.pathname.startsWith('/admin/shares/')) {
            const shareId = decodeURIComponent(url.pathname.replace('/admin/shares/', ''));
            response = await handleAdminShareDetail(request, params, env, shareId);
          } else if (url.pathname === '/admin/files') {
            response = await handleAdminFiles(request, params, env);
          } else if (url.pathname.startsWith('/admin/files/')) {
            const fsId = decodeURIComponent(url.pathname.replace('/admin/files/', ''));
            response = await handleAdminFileDetail(request, params, env, fsId);
          } else if (url.pathname === '/admin/thumbnails') {
            response = await handleAdminThumbnails(request, params, env);
          } else if (url.pathname === '/admin/analytics/processed') {
            response = await handleAdminAnalyticsProcessed(request, params, env);
          } else if (url.pathname === '/admin/kv/entry') {
            response = await handleAdminKvEntry(request, params, env);
          } else if (url.pathname === '/admin/kv/stats') {
            response = await handleAdminKvStats(request, params, env);
          } else {
            return withCors(errorJson(404, 'Not found', 'not_found'));
          }

          metricsInstance.trackRequest('admin');
          const duration = Math.round(performance.now() - startTime);
          metricsInstance.trackResponseTime('admin', duration);
          ctx.waitUntil(metricsInstance.flush());

          return withCors(response);
        } catch (err) {
          metricsInstance.trackError('admin', err?.message || 'unknown');
          ctx.waitUntil(metricsInstance.flush());
          return withCors(errorJson(500, err?.message || 'Internal error', 'internal_error'));
        }
      }

      // Health check endpoint
      if (mode === 'health') {
        return withCors(Response.json(
          {
            status: 'ok',
            timestamp: new Date().toISOString(),
            metrics: metricsInstance.getSummary()
          },
          { status: 200 }
        ));
      }

      // Metrics summary endpoint
      if (mode === 'metrics') {
        return withCors(Response.json(
          {
            timestamp: new Date().toISOString(),
            ...metricsInstance.getSummary()
          },
          { status: 200 }
        ));
      }

      // Clear metrics endpoint (admin)
      if (mode === 'metrics-reset') {
        const key = params.get('key');
        if (!env.SHARE_KV) {
          return withCors(errorJson(503, 'KV namespace not configured', 'kv_unavailable'));
        }
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
          return withCors(Response.json(
            { status: 'metrics cleared', timestamp: new Date().toISOString() },
            { status: 200 }
          ));
        }
        return withCors(errorJson(401, 'Unauthorized', 'unauthorized'));
      }

      const startTime = performance.now();
      let response;

      try {
        if (mode === 'page') response = await handlePage(request, params);
        else if (mode === 'api') response = await handleApi(request, params);
        else if (mode === 'resolve') response = await handleResolve(request, params, env, metricsInstance);
        else if (mode === 'stream') response = await handleStream(request, params, env, metricsInstance);
        else if (mode === 'segment') response = await handleSegment(request, params);
        else if (mode === 'lookup') response = await handleLookup(request, params, env);
        else {
          metricsInstance.trackError('unknown', 'invalid_mode');
          return withCors(Response.json(
            {
              error: 'Invalid or missing mode',
              code: 'invalid_mode',
              allowed: ['page', 'api', 'resolve', 'stream', 'segment', 'lookup', 'health', 'metrics', 'metrics-reset', 'admin/*']
            },
            { status: 400 }
          ));
        }

        // Track metrics
        metricsInstance.trackRequest(mode);
        const duration = Math.round(performance.now() - startTime);
        metricsInstance.trackResponseTime(mode, duration);

        // Non-blocking metrics save using waitUntil
        ctx.waitUntil(metricsInstance.flush());

        return withCors(response);
      } catch (err) {
        metricsInstance.trackError(mode, err?.message || 'unknown');
        ctx.waitUntil(metricsInstance.flush());
        throw err;
      }
    } catch (err) {
      return withCors(errorJson(500, err?.message || 'Internal error', 'internal_error'));
    }
  }
};
