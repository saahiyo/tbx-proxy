/**
 * Request handlers for different modes: page, api, resolve, stream, segment
 */

import { buildHeaders, extractJsToken, buildApiUrl, badRequest, jsonUpstream } from './utils.js';
import { rewriteM3U8 } from './m3u8.js';

/**
 * Handle page mode - fetches the share page
 */
export async function handlePage(request, params) {
  const surl = params.get('surl');
  if (!surl) return badRequest('Missing surl');

  const url = new URL('https://www.terabox.app/sharing/link');
  url.searchParams.set('surl', surl);

  const res = await fetch(url, {
    headers: buildHeaders(request, { Accept: 'text/html' }),
    redirect: 'follow'
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/**
 * Handle api mode - manual API call with jsToken and shorturl
 */
export async function handleApi(request, params) {
  const jsToken = params.get('jsToken');
  const shorturl = params.get('shorturl');
  if (!jsToken || !shorturl)
    return badRequest('Missing jsToken or shorturl', ['jsToken', 'shorturl']);

  const apiUrl = buildApiUrl(jsToken, shorturl, '1');

  const res = await fetch(apiUrl, {
    headers: buildHeaders(request, {
      Accept: 'application/json',
      Referer: 'https://terabox.com/'
    })
  });

  return jsonUpstream(res);
}

/**
 * Handle resolve mode - extract metadata and cache in KV
 */
export async function handleResolve(request, params, env, metrics) {
  const surl = params.get('surl');
  const refresh = params.get('refresh') === '1';
  const raw = params.get('raw') === '1';

  if (!surl) return badRequest('Missing surl');

  const kvKey = `share:${surl}`;

  if (!refresh && !raw) {
    try {
      const stored = await env.SHARE_KV.get(kvKey, { type: 'json' });
      if (metrics) metrics.trackKvOperation('read', true);
      if (stored) {
        if (metrics) metrics.trackCache(true);
        return Response.json({ source: 'kv', data: stored });
      }
      if (metrics) metrics.trackCache(false);
    } catch (err) {
      if (metrics) metrics.trackKvOperation('read', false);
    }
  }

  const pageUrl = new URL('https://www.terabox.app/sharing/link');
  pageUrl.searchParams.set('surl', surl);

  const pageRes = await fetch(pageUrl.toString(), {
    headers: buildHeaders(request, { Accept: 'text/html' }),
    redirect: 'follow'
  });

  const html = await pageRes.text();
  const jsToken = extractJsToken(html);

  if (!jsToken) {
    return Response.json(
      { error: 'Failed to extract jsToken' },
      { status: 403 }
    );
  }

  const apiUrl = buildApiUrl(jsToken, surl, '1');
  const apiRes = await fetch(apiUrl, {
    headers: buildHeaders(request, {
      Accept: 'application/json',
      Referer: 'https://terabox.com/'
    })
  });

  const upstream = await apiRes.json();
  if (!upstream?.list?.length) {
    if (metrics) metrics.trackUpstreamError();
    return Response.json(
      { error: 'Empty share list from upstream' },
      { status: 502 }
    );
  }

  if (raw) {
    return Response.json({ source: 'live', upstream });
  }

  const file = upstream.list[0];
  const now = Math.floor(Date.now() / 1000);

  const record = {
    name: file.server_filename,
    dlink: file.dlink,
    size: Number(file.size),
    time: Number(file.server_mtime),
    original_url: `https://terabox.app/s/${surl}`,
    thumb: file.thumbs?.url3 || file.thumbs?.url2 || file.thumbs?.url1 || null,
    uk: upstream.uk,
    shareid: upstream.shareid || upstream.share_id,
    fid: file.fs_id,
    stored_at: now,
    last_verified: now
  };

  try {
    // KV put with TTL (7 days)
    await env.SHARE_KV.put(kvKey, JSON.stringify(record), {
      expirationTtl: 7 * 24 * 60 * 60
    });
    if (metrics) metrics.trackKvOperation('write', true);
  } catch (err) {
    if (metrics) metrics.trackKvOperation('write', false);
  }

  return Response.json({ source: 'live', data: record });
}

/**
 * Handle stream mode - returns M3U8 playlist using stored metadata
 */
export async function handleStream(request, params, env, metrics) {
  const surl = params.get('surl');
  const type = params.get('type') || 'M3U8_AUTO_360';

  if (!surl) {
    return Response.json({ error: 'Missing surl' }, { status: 400 });
  }

  const kvKey = `share:${surl}`;
  let record;
  try {
    record = await env.SHARE_KV.get(kvKey, { type: 'json' });
    if (metrics) metrics.trackKvOperation('read', true);
    if (record) {
      if (metrics) metrics.trackCache(true);
    } else {
      if (metrics) metrics.trackCache(false);
    }
  } catch (err) {
    if (metrics) metrics.trackKvOperation('read', false);
  }

  if (!record) {
    return Response.json(
      { error: 'Share not found in KV. Call mode=resolve first.' },
      { status: 404 }
    );
  }

  const { uk, shareid, fid, dlink } = record;
  if (!uk || !shareid || !fid || !dlink) {
    return Response.json(
      { error: 'Incomplete stream metadata in KV' },
      { status: 500 }
    );
  }


/* Build streaming URL using signed dlink params */
const streamUrl = new URL('https://dm.1024tera.com/share/streaming');

streamUrl.searchParams.set('uk', uk);
  streamUrl.searchParams.set('shareid', shareid);
  streamUrl.searchParams.set('fid', fid);
  streamUrl.searchParams.set('type', type);
  streamUrl.searchParams.set('clienttype', '0');
  streamUrl.searchParams.set('app_id', '250528');
  streamUrl.searchParams.set('web', '1');
  streamUrl.searchParams.set('channel', 'dubox');
  streamUrl.searchParams.set('timestamp', '1234567890'); // required timestamp
  streamUrl.searchParams.set('sign', 'abcd'); // required sign

  const res = await fetch(streamUrl.toString(), {
    headers: buildHeaders(request, {
      Accept: '*/*',
      Referer: 'https://www.terabox.com/'
    })
  });

  const playlist = await res.text();
  const rewritten = rewriteM3U8(playlist, request);

  return new Response(rewritten, {
    status: res.status,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * Handle segment mode - proxies video segments
 */
export async function handleSegment(request, params) {
  const targetUrl = params.get('url');
  if (!targetUrl) {
    return Response.json({ error: 'Missing url param' }, { status: 400 });
  }

  const res = await fetch(targetUrl, {
    headers: buildHeaders(request, {
      Referer: 'https://www.terabox.com/'
    })
  });

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('content-type') || 'video/mp2t',
      'Cache-Control': 'no-store'
    }
  });
}
