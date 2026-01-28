import {
  handlePage,
  handleApi,
  handleResolve,
  handleStream,
  handleSegment
} from './handlers.js';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const params = url.searchParams;
      const mode = params.get('mode');

      if (mode === 'page') return handlePage(request, params);
      if (mode === 'api') return handleApi(request, params);
      if (mode === 'resolve') return handleResolve(request, params, env);
      if (mode === 'stream') return handleStream(request, params, env);
      if (mode === 'segment') return handleSegment(request, params);

      return Response.json(
        {
          error: 'Invalid or missing mode',
          allowed: ['page', 'api', 'resolve', 'stream', 'segment']
        },
        { status: 400 }
      );
    } catch (err) {
      return Response.json(
        { error: err?.message || 'Internal error' },
        { status: 500 }
      );
    }
  }
};
