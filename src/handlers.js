/**
 * Request handlers for different modes: page, api, resolve, stream, segment
 */

import { buildHeaders, extractJsToken, buildApiUrl, badRequest, jsonUpstream } from './utils.js';
import { rewriteM3U8 } from './m3u8.js';
import { storeUpstreamData, getShareFromDb } from './db.js';

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

  // Check KV cache first (unless refresh or raw mode)
  if (!refresh && !raw) {
    try {
      const stored = await env.SHARE_KV.get(kvKey, { type: 'json' });
      if (metrics) metrics.trackKvOperation('read', true);
      if (stored) {
        if (metrics) metrics.trackCache(true);
        return Response.json({
          source: 'kv',
          ...(!stored.dlink && { note: 'dlink requires valid TeraBox cookies to download' }),
          data: stored
        });
      }
      if (metrics) metrics.trackCache(false);
    } catch (err) {
      if (metrics) metrics.trackKvOperation('read', false);
    }
  }

  // For raw mode without refresh, check D1 cache first
  if (raw && !refresh && env.sharedfile) {
    try {
      const d1Data = await getShareFromDb(env.sharedfile, surl);
      if (d1Data) {
        if (metrics) metrics.trackCache(true);
        const hasDlink = d1Data.list?.some(f => f.dlink) || false;
        return Response.json({
          source: 'd1',
          ...(!hasDlink && { note: 'dlink requires valid TeraBox cookies to download' }),
          data: d1Data
        });
      }
      if (metrics) metrics.trackCache(false);
    } catch (err) {
      console.error('D1 cache check error:', err);
    }
  }

  // Fetch fresh from upstream
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

  // Store complete data in D1 for persistence (always, regardless of raw mode)
  try {
    if (env.sharedfile) {
      await storeUpstreamData(env.sharedfile, surl, upstream);
    }
  } catch (err) {
    console.error('D1 storage error:', err);
  }

  if (raw) {
    const hasDlink = upstream.list?.some(f => f.dlink) || false;
    return Response.json({
      source: 'live',
      ...(!hasDlink && { note: 'dlink requires valid TeraBox cookies to download' }),
      upstream
    });
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

  return Response.json({
    source: 'live',
    ...(!record.dlink && { note: 'dlink requires valid TeraBox cookies to download' }),
    data: record
  });
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
 * Allowed domains for segment proxying (SSRF protection)
 */
const ALLOWED_SEGMENT_DOMAINS = [
  'terabox.com',
  'terabox.app',
  '1024tera.com',
  '1024terabox.com',
  'teraboxcdn.com',
  'dm.terabox.app',
  'dm.1024tera.com',
  'terasharelink.com',
  'terafileshare.com',
  'teraboxlink.com',
  'teraboxshare.com'
];

/**
 * Validate that URL belongs to an allowed TeraBox domain
 */
function isAllowedSegmentUrl(urlString) {
  try {
    const url = new URL(urlString);
    return ALLOWED_SEGMENT_DOMAINS.some(domain => 
      url.hostname === domain || url.hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

/**
 * Handle segment mode - proxies video segments
 */
export async function handleSegment(request, params) {
  const targetUrl = params.get('url');
  if (!targetUrl) {
    return Response.json({ error: 'Missing url param' }, { status: 400 });
  }

  // SSRF protection: only allow TeraBox domains
  if (!isAllowedSegmentUrl(targetUrl)) {
    return Response.json(
      { error: 'Invalid segment URL: only TeraBox domains allowed' },
      { status: 403 }
    );
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

/**
 * Handle lookup mode - query D1 database directly without hitting upstream
 * Supports lookup by share ID (surl) or file ID (fid)
 */
export async function handleLookup(request, params, env) {
  const surl = params.get('surl');
  const fid = params.get('fid');

  if (!surl && !fid) {
    return badRequest('Missing surl or fid parameter', ['surl', 'fid']);
  }

  if (!env.sharedfile) {
    return Response.json(
      { error: 'D1 database not configured' },
      { status: 503 }
    );
  }

  try {
    // Lookup by file ID
    if (fid) {
      const file = await env.sharedfile
        .prepare('SELECT * FROM media_files WHERE fs_id = ?')
        .bind(fid)
        .first();

      if (!file) {
        return Response.json(
          { error: 'File not found', fid },
          { status: 404 }
        );
      }

      // Get thumbnails for this file
      const thumbs = await env.sharedfile
        .prepare('SELECT url, thumbnail_type FROM thumbnails WHERE fs_id = ?')
        .bind(fid)
        .all();

      const thumbsObj = {};
      thumbs.results.forEach(t => {
        thumbsObj[t.thumbnail_type] = t.url;
      });

      return Response.json({
        source: 'd1',
        ...(!file.dlink && { note: 'dlink requires valid TeraBox cookies to download' }),
        data: { ...file, thumbs: thumbsObj }
      });
    }

    // Lookup by share ID
    const shareData = await getShareFromDb(env.sharedfile, surl);

    if (!shareData) {
      return Response.json(
        { error: 'Share not found in D1. Use mode=resolve first.', surl },
        { status: 404 }
      );
    }

    const hasDlink = shareData.list?.some(f => f.dlink) || false;
    return Response.json({
      source: 'd1',
      ...(!hasDlink && { note: 'dlink requires valid TeraBox cookies to download' }),
      data: shareData
    });
  } catch (err) {
    console.error('D1 lookup error:', err);
    return Response.json(
      { error: 'Database query failed', details: err.message },
      { status: 500 }
    );
  }
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeOrder(order) {
  return order && order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

function normalizeSort(sort, allowed, fallback) {
  return allowed.includes(sort) ? sort : fallback;
}

function requireD1(env) {
  if (!env.sharedfile) {
    return Response.json(
      { error: 'D1 database not configured' },
      { status: 503 }
    );
  }
  return null;
}

function requireKv(env) {
  if (!env.SHARE_KV) {
    return Response.json(
      { error: 'KV namespace not configured' },
      { status: 503 }
    );
  }
  return null;
}

export async function handleAdminOverview(request, params, env) {
  const missing = requireD1(env);
  if (missing) return missing;

  const sharesCount = await env.sharedfile
    .prepare('SELECT COUNT(*) as total FROM shares')
    .first();
  const filesCount = await env.sharedfile
    .prepare('SELECT COUNT(*) as total FROM media_files')
    .first();
  const thumbsCount = await env.sharedfile
    .prepare('SELECT COUNT(*) as total FROM thumbnails')
    .first();
  const latestShares = await env.sharedfile
    .prepare('SELECT share_id, title, updated_at FROM shares ORDER BY updated_at DESC LIMIT 20')
    .all();

  return Response.json({
    counts: {
      shares: sharesCount?.total || 0,
      media_files: filesCount?.total || 0,
      thumbnails: thumbsCount?.total || 0
    },
    latestShares: latestShares?.results || []
  });
}

export async function handleAdminShares(request, params, env) {
  const missing = requireD1(env);
  if (missing) return missing;

  const q = params.get('q')?.trim();
  const sort = normalizeSort(params.get('sort'), ['updated_at', 'server_time', 'title'], 'updated_at');
  const order = normalizeOrder(params.get('order'));
  const page = parsePositiveInt(params.get('page'), 1);
  const pageSize = clamp(parsePositiveInt(params.get('pageSize'), 50), 1, 200);
  const offset = (page - 1) * pageSize;

  const where = q ? 'WHERE share_id LIKE ? OR title LIKE ? OR uk LIKE ?' : '';
  const binds = [];
  if (q) {
    const like = `%${q}%`;
    binds.push(like, like, like);
  }

  const totalRow = await env.sharedfile
    .prepare(`SELECT COUNT(*) as total FROM shares ${where}`)
    .bind(...binds)
    .first();

  const list = await env.sharedfile
    .prepare(
      `SELECT share_id, uk, title, server_time, request_id, updated_at
       FROM shares ${where}
       ORDER BY ${sort} ${order}
       LIMIT ? OFFSET ?`
    )
    .bind(...binds, pageSize, offset)
    .all();

  return Response.json({
    page,
    pageSize,
    total: totalRow?.total || 0,
    items: list?.results || []
  });
}

export async function handleAdminShareDetail(request, params, env, shareId) {
  if (!shareId) return badRequest('Missing share_id');
  const missing = requireD1(env);
  if (missing) return missing;

  const share = await env.sharedfile
    .prepare('SELECT * FROM shares WHERE share_id = ?')
    .bind(shareId)
    .first();

  if (!share) {
    return Response.json({ error: 'Share not found', share_id: shareId }, { status: 404 });
  }

  const page = parsePositiveInt(params.get('page'), 1);
  const pageSize = clamp(parsePositiveInt(params.get('pageSize'), 50), 1, 200);
  const offset = (page - 1) * pageSize;

  const totalFilesRow = await env.sharedfile
    .prepare('SELECT COUNT(*) as total FROM media_files WHERE share_id = ?')
    .bind(shareId)
    .first();

  const files = await env.sharedfile
    .prepare(
      `SELECT * FROM media_files
       WHERE share_id = ?
       ORDER BY server_mtime DESC
       LIMIT ? OFFSET ?`
    )
    .bind(shareId, pageSize, offset)
    .all();

  const fileIds = (files?.results || []).map(f => f.fs_id).filter(Boolean);
  let thumbsByFsId = {};
  if (fileIds.length > 0 && fileIds.length <= 200) {
    const placeholders = fileIds.map(() => '?').join(',');
    const thumbs = await env.sharedfile
      .prepare(`SELECT fs_id, url, thumbnail_type FROM thumbnails WHERE fs_id IN (${placeholders})`)
      .bind(...fileIds)
      .all();

    thumbsByFsId = {};
    (thumbs?.results || []).forEach(t => {
      if (!thumbsByFsId[t.fs_id]) thumbsByFsId[t.fs_id] = {};
      thumbsByFsId[t.fs_id][t.thumbnail_type] = t.url;
    });
  }

  return Response.json({
    share,
    files: files?.results || [],
    thumbsByFsId,
    page,
    pageSize,
    totalFiles: totalFilesRow?.total || 0
  });
}

export async function handleAdminFiles(request, params, env) {
  const missing = requireD1(env);
  if (missing) return missing;

  const q = params.get('q')?.trim();
  const shareId = params.get('share_id')?.trim();
  const sizeMin = params.get('size_min');
  const sizeMax = params.get('size_max');
  const sort = normalizeSort(params.get('sort'), ['server_mtime', 'size', 'server_filename'], 'server_mtime');
  const order = normalizeOrder(params.get('order'));
  const page = parsePositiveInt(params.get('page'), 1);
  const pageSize = clamp(parsePositiveInt(params.get('pageSize'), 50), 1, 200);
  const offset = (page - 1) * pageSize;

  const whereParts = [];
  const binds = [];

  if (shareId) {
    whereParts.push('share_id = ?');
    binds.push(shareId);
  }
  if (q) {
    whereParts.push('(server_filename LIKE ? OR fs_id LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like);
  }
  if (sizeMin) {
    whereParts.push('size >= ?');
    binds.push(Number(sizeMin));
  }
  if (sizeMax) {
    whereParts.push('size <= ?');
    binds.push(Number(sizeMax));
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const totalRow = await env.sharedfile
    .prepare(`SELECT COUNT(*) as total FROM media_files ${where}`)
    .bind(...binds)
    .first();

  const list = await env.sharedfile
    .prepare(
      `SELECT * FROM media_files ${where}
       ORDER BY ${sort} ${order}
       LIMIT ? OFFSET ?`
    )
    .bind(...binds, pageSize, offset)
    .all();

  return Response.json({
    page,
    pageSize,
    total: totalRow?.total || 0,
    items: list?.results || []
  });
}

export async function handleAdminFileDetail(request, params, env, fsId) {
  if (!fsId) return badRequest('Missing fs_id');
  const missing = requireD1(env);
  if (missing) return missing;

  const file = await env.sharedfile
    .prepare('SELECT * FROM media_files WHERE fs_id = ?')
    .bind(fsId)
    .first();

  if (!file) {
    return Response.json({ error: 'File not found', fs_id: fsId }, { status: 404 });
  }

  const thumbs = await env.sharedfile
    .prepare('SELECT url, thumbnail_type FROM thumbnails WHERE fs_id = ?')
    .bind(fsId)
    .all();

  const thumbsObj = {};
  (thumbs?.results || []).forEach(t => {
    thumbsObj[t.thumbnail_type] = t.url;
  });

  return Response.json({
    file,
    thumbs: thumbsObj
  });
}

export async function handleAdminThumbnails(request, params, env) {
  const missing = requireD1(env);
  if (missing) return missing;

  const fsId = params.get('fs_id')?.trim();
  const type = params.get('type')?.trim();
  const page = parsePositiveInt(params.get('page'), 1);
  const pageSize = clamp(parsePositiveInt(params.get('pageSize'), 50), 1, 200);
  const offset = (page - 1) * pageSize;

  const whereParts = [];
  const binds = [];

  if (fsId) {
    whereParts.push('fs_id = ?');
    binds.push(fsId);
  }
  if (type) {
    whereParts.push('thumbnail_type = ?');
    binds.push(type);
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const totalRow = await env.sharedfile
    .prepare(`SELECT COUNT(*) as total FROM thumbnails ${where}`)
    .bind(...binds)
    .first();

  const list = await env.sharedfile
    .prepare(
      `SELECT * FROM thumbnails ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...binds, pageSize, offset)
    .all();

  return Response.json({
    page,
    pageSize,
    total: totalRow?.total || 0,
    items: list?.results || []
  });
}

export async function handleAdminAnalyticsProcessed(request, params, env) {
  const missing = requireD1(env);
  if (missing) return missing;

  const limit = clamp(parsePositiveInt(params.get('limit'), 30), 1, 180);
  const rows = await env.sharedfile
    .prepare(
      `SELECT DATE(updated_at) as day, COUNT(*) as shares
       FROM shares
       GROUP BY day
       ORDER BY day DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  return Response.json({
    limit,
    items: rows?.results || []
  });
}

export async function handleAdminKvEntry(request, params, env) {
  const missing = requireKv(env);
  if (missing) return missing;

  const surl = params.get('surl');
  if (!surl) return badRequest('Missing surl');

  try {
    const record = await env.SHARE_KV.get(`share:${surl}`, { type: 'json' });
    if (!record) {
      return Response.json({ error: 'KV entry not found', surl }, { status: 404 });
    }
    return Response.json({ surl, data: record });
  } catch (err) {
    return Response.json({ error: 'KV read failed', details: err.message }, { status: 500 });
  }
}

export async function handleAdminKvStats(request, params, env) {
  const missing = requireKv(env);
  if (missing) return missing;

  try {
    const metrics = await env.SHARE_KV.get('metrics:current', { type: 'json' });
    return Response.json({
      metrics: metrics || null,
      note: 'KV does not support listing all keys; stats are derived from stored metrics only.'
    });
  } catch (err) {
    return Response.json({ error: 'KV read failed', details: err.message }, { status: 500 });
  }
}
