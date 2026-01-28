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

/* =============================
   STREAM (USING DLINK CONTEXT)
============================= */
async function handleStream(request, params, env) {
  const surl = params.get('surl');
  const type = params.get('type') || 'M3U8_AUTO_360';

  if (!surl) {
    return Response.json({ error: 'Missing surl' }, { status: 400 });
  }

  const kvKey = `share:${surl}`;
  const record = await env.SHARE_KV.get(kvKey, { type: 'json' });

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

  /* Reuse signed session params from dlink */
  const dlinkParams = new URL(dlink).searchParams;
  for (const [k, v] of dlinkParams.entries()) {
    streamUrl.searchParams.set(k, v);
  }

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

/* =============================
   SEGMENT
============================= */
async function handleSegment(request, params) {
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

/* =============================
   PAGE
============================= */
async function handlePage(request, params) {
  const surl = params.get('surl');
  if (!surl) return bad('Missing surl');

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

/* =============================
   API (MANUAL)
============================= */
async function handleApi(request, params) {
  const jsToken = params.get('jsToken');
  const shorturl = params.get('shorturl');
  if (!jsToken || !shorturl)
    return bad('Missing jsToken or shorturl', ['jsToken', 'shorturl']);

  const apiUrl = buildApiUrl(jsToken, shorturl, '1');

  const res = await fetch(apiUrl, {
    headers: buildHeaders(request, {
      Accept: 'application/json',
      Referer: 'https://terabox.com/'
    })
  });

  return jsonUpstream(res);
}

/* =============================
   RESOLVE + STORE IN KV
============================= */
async function handleResolve(request, params, env) {
  const surl = params.get('surl');
  const refresh = params.get('refresh') === '1';
  const raw = params.get('raw') === '1';

  if (!surl) return bad('Missing surl');

  const kvKey = `share:${surl}`;

  if (!refresh && !raw) {
    const stored = await env.SHARE_KV.get(kvKey, { type: 'json' });
    if (stored) {
      return Response.json({ source: 'kv', data: stored });
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
    uk: upstream.uk,
    shareid: upstream.shareid || upstream.share_id,
    fid: file.fs_id,
    stored_at: now,
    last_verified: now
  };

  await env.SHARE_KV.put(kvKey, JSON.stringify(record));

  return Response.json({ source: 'live', data: record });
}

/* =============================
   HELPERS
============================= */

function rewriteM3U8(content, request) {
  const base = new URL(request.url);
  base.search = '';

  return content
    .split('\n')
    .map(line => {
      if (
        line.startsWith('#') ||
        line.trim() === '' ||
        !line.startsWith('http')
      ) {
        return line;
      }
      const u = new URL(base.toString());
      u.searchParams.set('mode', 'segment');
      u.searchParams.set('url', line);
      return u.toString();
    })
    .join('\n');
}

function extractJsToken(html) {
  return findBetween(html, 'fn%28%22', '%22%29');
}

function findBetween(str, start, end) {
  const i = str.indexOf(start);
  if (i === -1) return null;
  const j = str.indexOf(end, i + start.length);
  if (j === -1) return null;
  return str.slice(i + start.length, j);
}

function buildApiUrl(jsToken, shorturl, root) {
  const u = new URL('https://dm.terabox.app/share/list');
  u.searchParams.set('jsToken', jsToken);
  u.searchParams.set('shorturl', shorturl);
  u.searchParams.set('root', root);
  return u.toString();
}

async function jsonUpstream(res) {
  const ct = res.headers.get('content-type') || '';
  return Response.json(
    ct.includes('application/json')
      ? await res.json()
      : { error: 'Non-JSON response', status: res.status },
    { status: res.status }
  );
}

function buildHeaders(request, extra = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    ...extra
  };
  const cookie = request.headers.get('Cookie');
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function bad(msg, required) {
  return Response.json(
    { error: msg, ...(required ? { required } : {}) },
    { status: 400 }
  );
}
