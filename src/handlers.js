/**
 * Request handlers for different modes: page, api, resolve, stream, segment
 */

import { buildHeaders, extractJsToken, buildApiUrl, badRequest, jsonUpstream, errorJson, isValidSurl, normalizeSurl } from './utils.js';
import { rewriteM3U8 } from './m3u8.js';
import { storeUpstreamData, getShareFromDb } from './db.js';
const UPSTREAM_DOMAINS = [
  'terabox.app',
  'www.terabox.app',
  'www.terabox.com',
  'www.1024tera.com',
  'teraboxurl.com',
  'www.teraboxurl.com',
  'teraboxshare.com',
  'www.teraboxshare.com',
  'terasharelink.com',
  'www.terasharelink.com',
  '1024terabox.com',
  'www.1024terabox.com'
];

function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function mergeCookies(currentCookieHeader, setCookieHeaders) {
  const cookieMap = new Map();

  if (currentCookieHeader) {
    currentCookieHeader.split(';').forEach(c => {
      const parts = c.split('=');
      if (parts.length >= 2) {
        cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
      }
    });
  }

  setCookieHeaders.forEach(sc => {
    const firstPart = sc.split(';')[0];
    const parts = firstPart.split('=');
    if (parts.length >= 2) {
      cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
    }
  });

  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOptions = {
    ...options,
    redirect: 'manual',
    signal: controller.signal
  };

  let currentUrl = url.toString();
  let redirectsFollowed = 0;
  const maxRedirects = 5;
  const visitedUrls = new Set([currentUrl]);

  try {
    while (true) {
      console.log(`[fetchWithTimeout] Fetching: ${currentUrl}`);
      console.log(`[fetchWithTimeout] Cookie header: ${fetchOptions.headers?.Cookie || fetchOptions.headers?.cookie || 'none'}`);
      
      const res = await fetch(currentUrl, fetchOptions);
      console.log(`[fetchWithTimeout] Response status: ${res.status}`);

      // Check for manual redirect follow to preserve cookies/headers
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('Location');
        console.log(`[fetchWithTimeout] Redirecting to Location: ${location}`);
        if (!location) {
          return res;
        }

        if (redirectsFollowed >= maxRedirects) {
          throw new Error('Too many redirects followed in manual redirect handler');
        }

        const nextUrl = new URL(location, currentUrl).toString();
        if (visitedUrls.has(nextUrl)) {
          console.warn(`[fetchWithTimeout] Redirect loop detected: ${nextUrl} already visited. Stopping.`);
          return res;
        }

        // Extract and merge Set-Cookie headers from redirect response
        let setCookies = [];
        if (typeof res.headers.getSetCookie === 'function') {
          setCookies = res.headers.getSetCookie();
        } else {
          const rawSetCookie = res.headers.get('Set-Cookie');
          if (rawSetCookie) setCookies = [rawSetCookie];
        }

        if (setCookies.length > 0) {
          const currentCookie = fetchOptions.headers?.Cookie || fetchOptions.headers?.cookie || '';
          const newCookie = mergeCookies(currentCookie, setCookies);
          if (newCookie) {
            if (!fetchOptions.headers) fetchOptions.headers = {};
            fetchOptions.headers.Cookie = newCookie;
            delete fetchOptions.headers.cookie; // Normalize casing
          }
        }

        currentUrl = nextUrl;
        visitedUrls.add(currentUrl);
        redirectsFollowed++;
        continue;
      }

      return res;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(url, options, retries = 2, baseDelayMs = 200, timeoutMs = 8000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok || !isTransientStatus(res.status) || attempt === retries) {
        return res;
      }
      lastErr = new Error(`Transient upstream status: ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
    }

    const delay = baseDelayMs * Math.pow(2, attempt);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw lastErr || new Error('Upstream request failed');
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getProxyThumbnailUrl(origin, fid, size, surl) {
  const params = new URLSearchParams();
  params.set('mode', 'thumbnail');
  params.set('fid', fid);
  if (size && size !== 'url3') {
    params.set('size', size);
  }
  if (surl) {
    params.set('surl', surl);
  }
  return `${origin}/?${params.toString()}`;
}

function rewriteResponseThumbnails(obj, requestUrl, surl) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const origin = new URL(requestUrl).origin;
  
  const processFile = (file, fileSurl) => {
    const fid = file.fs_id || file.fid;
    if (!fid) return;
    
    const resolvedSurl = fileSurl || file.share_id || surl;
    
    if (file.thumb && typeof file.thumb === 'string' && !file.thumb.includes('mode=thumbnail')) {
      file.thumb = getProxyThumbnailUrl(origin, fid, 'url3', resolvedSurl);
    }
    
    if (file.thumbs && typeof file.thumbs === 'object') {
      for (const key of Object.keys(file.thumbs)) {
        if (typeof file.thumbs[key] === 'string' && !file.thumbs[key].includes('mode=thumbnail')) {
          file.thumbs[key] = getProxyThumbnailUrl(origin, fid, key, resolvedSurl);
        }
      }
    }
  };

  if (Array.isArray(obj.list)) {
    obj.list.forEach(file => processFile(file, obj.share_id || surl));
  }
  
  if (obj.data) {
    if (Array.isArray(obj.data.list)) {
      obj.data.list.forEach(file => processFile(file, obj.data.share_id || surl));
    } else if (typeof obj.data === 'object') {
      processFile(obj.data, surl);
    }
  }
  
  return obj;
}

function buildResolvedRecord(surl, share, file, storedAt, requestUrl) {
  if (!share || !file) return null;

  const fid = file.fs_id || file.fid || null;
  let thumbUrl = file.thumbs?.url3 || file.thumbs?.url2 || file.thumbs?.url1 || file.thumb || null;
  if (fid && requestUrl) {
    const origin = new URL(requestUrl).origin;
    thumbUrl = getProxyThumbnailUrl(origin, fid, 'url3', surl);
  }

  return {
    name: file.server_filename || file.name || null,
    dlink: file.dlink || null,
    size: toOptionalNumber(file.size),
    time: toOptionalNumber(file.server_mtime || file.time),
    original_url: `https://terabox.app/s/${surl}`,
    thumb: thumbUrl,
    uk: share.uk || null,
    shareid: share.shareid || share.share_id || null,
    fid: fid,
    stored_at: storedAt ?? null,
    last_verified: storedAt ?? null
  };
}

function buildResolvedRecordFromDb(surl, shareData, requestUrl) {
  const file = shareData?.list?.[0];
  const storedAt = shareData?.updated_at
    ? Math.floor(new Date(shareData.updated_at).getTime() / 1000)
    : null;

  return buildResolvedRecord(surl, shareData, file, storedAt, requestUrl);
}

function buildResolvedRecordFromUpstream(surl, upstream, requestUrl) {
  const file = upstream?.list?.[0];
  const now = Math.floor(Date.now() / 1000);

  return buildResolvedRecord(
    surl,
    {
      uk: upstream?.uk,
      shareid: upstream?.shareid || upstream?.share_id || null
    },
    file,
    now,
    requestUrl
  );
}

/**
 * Handle page mode - fetches the share page
 */
export async function handlePage(request, params) {
  const surl = normalizeSurl(params.get('surl'));
  if (!surl) return badRequest('Missing surl');
  if (!isValidSurl(surl)) return badRequest('Invalid surl format');

  let lastErr;
  let htmlContent = null;
  let successStatus = 200;

  for (const domain of UPSTREAM_DOMAINS) {
    const url = new URL(`https://${domain}/sharing/link`);
    url.searchParams.set('surl', surl);

    try {
      const res = await fetchWithTimeout(url, {
        headers: buildHeaders(request, { Accept: 'text/html' }),
        redirect: 'follow'
      }, 8000);

      if (res.ok) {
        const text = await res.text();
        if (!text.includes('need verify') && text.length > 500) {
          htmlContent = text;
          successStatus = res.status;
          break;
        }
        lastErr = new Error(`Verification challenge or truncated HTML (${text.length} bytes) on domain ${domain}`);
      } else {
        lastErr = new Error(`Upstream status ${res.status} on domain ${domain}`);
      }
    } catch (err) {
      lastErr = err;
    }

    // Anonymous fallback if cookie-based request was blocked or challenged
    const hasCookies = !!request.headers.get('Cookie');
    if (!htmlContent && hasCookies) {
      try {
        console.log(`[handlePage] Cookie-based request failed for ${domain}. Retrying anonymously...`);
        const anonHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html'
        };
        const acceptLang = request.headers.get('Accept-Language');
        if (acceptLang) anonHeaders['Accept-Language'] = acceptLang;

        const res = await fetchWithTimeout(url, {
          headers: anonHeaders,
          redirect: 'follow'
        }, 8000);

        if (res.ok) {
          const text = await res.text();
          if (!text.includes('need verify') && text.length > 500) {
            htmlContent = text;
            successStatus = res.status;
            break;
          }
          lastErr = new Error(`Verification challenge or truncated HTML (${text.length} bytes) on domain ${domain} (anonymous fallback)`);
        } else {
          lastErr = new Error(`Upstream status ${res.status} on domain ${domain} (anonymous fallback)`);
        }
      } catch (err) {
        lastErr = err;
      }
    }
  }

  if (htmlContent === null) {
    return errorJson(502, 'All upstream domains failed or required verification', 'upstream_failed_all', {
      reason: lastErr?.message || 'unknown'
    });
  }

  return new Response(htmlContent, {
    status: successStatus,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/**
 * Handle api mode - manual API call with jsToken and shorturl
 */
export async function handleApi(request, params) {
  const jsToken = params.get('jsToken');
  const shorturl = normalizeSurl(params.get('shorturl'));
  if (!jsToken || !shorturl)
    return badRequest('Missing jsToken or shorturl', ['jsToken', 'shorturl']);
  if (!isValidSurl(shorturl)) return badRequest('Invalid shorturl format');

  const apiUrl = buildApiUrl(jsToken, shorturl, '1');

  let res;
  try {
    res = await fetchWithTimeout(apiUrl, {
      headers: buildHeaders(request, {
        Accept: 'application/json',
        Referer: 'https://terabox.com/'
      })
    }, 8000);
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return errorJson(504, 'Upstream API request timed out', 'upstream_timeout', {
      reason: isAbort ? 'timeout' : 'network_error'
    });
  }

  return jsonUpstream(res, 'Upstream API request failed');
}

/**
 * Handle resolve mode - extract metadata and cache in D1 when available
 */
export async function handleResolve(request, params, env) {
  const surl = normalizeSurl(params.get('surl'));
  const refresh = params.get('refresh') === '1';
  const raw = params.get('raw') === '1';

  if (!surl) return badRequest('Missing surl');
  if (!isValidSurl(surl)) return badRequest('Invalid surl format');

  if (!refresh && env.sharedfile) {
    try {
      const d1Data = await getShareFromDb(env.sharedfile, surl);
      if (d1Data) {
        const storedAt = d1Data.updated_at
          ? Math.floor(new Date(d1Data.updated_at).getTime() / 1000)
          : null;
        const now = Math.floor(Date.now() / 1000);
        const isExpired = storedAt && (now - storedAt > 8 * 3600); // 8 hours TTL

        if (!isExpired) {
          const responseData = raw ? d1Data : buildResolvedRecordFromDb(surl, d1Data, request.url);
          const hasDlink = raw
            ? d1Data.list?.some(f => f.dlink) || false
            : !!responseData?.dlink;

          if (responseData) {
            const finalData = raw ? rewriteResponseThumbnails(responseData, request.url, surl) : responseData;
            return Response.json({
              source: 'd1',
              ...(!hasDlink && { note: 'dlink requires valid TeraBox cookies to download' }),
              data: finalData
            });
          }
        }
      }
    } catch (err) {
      console.error('D1 cache check error:', err);
    }
  }



  let pageRes = null;
  let html = '';
  let jsToken = null;
  let lastErr = null;

  for (const domain of UPSTREAM_DOMAINS) {
    const pageUrl = new URL(`https://${domain}/sharing/link`);
    pageUrl.searchParams.set('surl', surl);

    try {
      pageRes = await fetchWithRetry(pageUrl.toString(), {
        headers: buildHeaders(request, { Accept: 'text/html' }),
        redirect: 'follow'
      }, 1, 200, 8000);

      if (pageRes && pageRes.ok) {
        html = await pageRes.text();
        jsToken = extractJsToken(html);
        if (jsToken && html.length > 500 && !html.includes('need verify')) {
          break;
        }
        jsToken = null;
        lastErr = new Error(`Verification challenge or invalid page on domain ${domain}`);
      } else {
        lastErr = new Error(`Upstream page request failed with status ${pageRes?.status} on domain ${domain}`);
      }
    } catch (err) {
      lastErr = err;
    }

    // Anonymous fallback if cookie-based request was blocked or challenged
    const hasCookies = !!request.headers.get('Cookie');
    if (!jsToken && hasCookies) {
      try {
        console.log(`[handleResolve] Cookie-based request failed for ${domain}. Retrying anonymously...`);
        const anonHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html'
        };
        const acceptLang = request.headers.get('Accept-Language');
        if (acceptLang) anonHeaders['Accept-Language'] = acceptLang;

        pageRes = await fetchWithRetry(pageUrl.toString(), {
          headers: anonHeaders,
          redirect: 'follow'
        }, 1, 200, 8000);

        if (pageRes && pageRes.ok) {
          html = await pageRes.text();
          jsToken = extractJsToken(html);
          if (jsToken && html.length > 500 && !html.includes('need verify')) {
            break;
          }
          jsToken = null;
          lastErr = new Error(`Verification challenge or invalid page on domain ${domain} (anonymous fallback)`);
        } else {
          lastErr = new Error(`Upstream page request failed with status ${pageRes?.status} on domain ${domain} (anonymous fallback)`);
        }
      } catch (err) {
        lastErr = err;
      }
    }
  }

  if (!jsToken) {
    return errorJson(
      403,
      'Failed to extract jsToken across all candidate domains',
      'token_extract_failed_all',
      { reason: lastErr?.message || 'unknown' }
    );
  }

  let apiRes;
  try {
    // Extract Set-Cookie headers from page response
    let setCookies = [];
    if (typeof pageRes.headers.getSetCookie === 'function') {
      setCookies = pageRes.headers.getSetCookie();
    } else {
      const rawSetCookie = pageRes.headers.get('Set-Cookie');
      if (rawSetCookie) setCookies = [rawSetCookie];
    }

    // Merge incoming request cookies with cookies set by the page fetch
    const incomingCookie = request.headers.get('Cookie');
    let mergedCookie = incomingCookie;
    if (setCookies.length > 0) {
      const cookiesObj = {};
      if (incomingCookie) {
        incomingCookie.split(';').forEach(c => {
          const parts = c.split('=');
          if (parts.length >= 2) cookiesObj[parts[0].trim()] = parts.slice(1).join('=').trim();
        });
      }
      setCookies.forEach(sc => {
        const firstPart = sc.split(';')[0];
        const parts = firstPart.split('=');
        if (parts.length >= 2) cookiesObj[parts[0].trim()] = parts.slice(1).join('=').trim();
      });
      mergedCookie = Object.entries(cookiesObj).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const apiHeaders = buildHeaders(request, {
      Accept: 'application/json',
      Referer: 'https://terabox.com/'
    });
    if (mergedCookie) {
      apiHeaders.Cookie = mergedCookie;
    }

    const apiUrl = buildApiUrl(jsToken, surl, '1');
    apiRes = await fetchWithRetry(apiUrl, { headers: apiHeaders }, 2, 200, 8000);
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return errorJson(
      isAbort ? 504 : 502,
      isAbort ? 'Upstream API request timed out' : 'Upstream API request failed',
      isAbort ? 'upstream_timeout' : 'upstream_error',
      err?.message || (isAbort ? 'timeout' : 'network_error')
    );
  }

  if (!apiRes.ok) {
    return errorJson(502, 'Upstream API request failed', 'upstream_error', {
      status: apiRes.status
    });
  }

  let upstream;
  try {
    upstream = await apiRes.json();
  } catch {
    return errorJson(502, 'Upstream returned non-JSON', 'upstream_non_json', {
      status: apiRes.status
    });
  }
  if (!upstream?.list?.length) {
    return errorJson(502, 'Empty share list from upstream', 'upstream_empty', upstream);
  }

  // Store complete data in D1 for persistence when configured.
  try {
    if (env.sharedfile) {
      await storeUpstreamData(env.sharedfile, surl, upstream);
    }
  } catch (err) {
    console.error('D1 storage error:', err);
  }

  if (raw) {
    const hasDlink = upstream.list?.some(f => f.dlink) || false;
    const rewrittenUpstream = rewriteResponseThumbnails(upstream, request.url, surl);
    return Response.json({
      source: 'live',
      ...(!hasDlink && { note: 'dlink requires valid TeraBox cookies to download' }),
      upstream: rewrittenUpstream
    });
  }

  const record = buildResolvedRecordFromUpstream(surl, upstream, request.url);
  return Response.json({
    source: 'live',
    ...(!record?.dlink && { note: 'dlink requires valid TeraBox cookies to download' }),
    data: record
  });
}

function hasStreamMetadata(record) {
  return !!(record?.uk && record?.shareid && record?.fid && record?.dlink);
}

function getStreamAuthFromDlink(dlink) {
  if (!dlink) return null;

  try {
    const url = new URL(dlink);
    const sign = url.searchParams.get('sign');
    const timestamp = url.searchParams.get('dstime') || url.searchParams.get('timestamp');
    const logid = url.searchParams.get('dp-logid');

    if (!sign || !timestamp) {
      return null;
    }

    return { sign, timestamp, logid };
  } catch {
    return null;
  }
}

/**
 * Handle stream mode - returns M3U8 playlist using cached metadata
 */
export async function handleStream(request, params, env) {
  const surl = normalizeSurl(params.get('surl'));
  const type = params.get('type') || 'M3U8_AUTO_360';

  if (!surl) {
    return badRequest('Missing surl', ['surl']);
  }
  if (!isValidSurl(surl)) {
    return badRequest('Invalid surl format');
  }

  let record = null;
  if (env.sharedfile) {
    try {
      const cachedShare = await getShareFromDb(env.sharedfile, surl);
      if (cachedShare) {
        record = buildResolvedRecordFromDb(surl, cachedShare, request.url);
      }
    } catch (err) {
      console.error('D1 stream cache check error:', err);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const isExpired = record?.stored_at && (now - record.stored_at > 8 * 3600); // 8 hours TTL

  if (!hasStreamMetadata(record) || isExpired) {
    const resolveParams = new URLSearchParams(params);
    resolveParams.delete('raw');
    resolveParams.set('refresh', '1');

    const resolveRes = await handleResolve(request, resolveParams, env);
    if (!resolveRes.ok) {
      return resolveRes;
    }

    try {
      const resolvedBody = await resolveRes.json();
      record = resolvedBody?.data || null;
    } catch {
      record = null;
    }

    if (!hasStreamMetadata(record)) {
      return errorJson(500, 'Incomplete stream metadata', 'incomplete_metadata');
    }
  }

  const { uk, shareid, fid, dlink } = record;
  if (!uk || !shareid || !fid || !dlink) {
    return errorJson(500, 'Incomplete stream metadata', 'incomplete_metadata');
  }

  const streamAuth = getStreamAuthFromDlink(dlink);
  if (!streamAuth) {
    return errorJson(
      502,
      'Missing signed stream parameters in dlink',
      'stream_auth_missing'
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
  streamUrl.searchParams.set('timestamp', streamAuth.timestamp);
  streamUrl.searchParams.set('sign', streamAuth.sign);
  if (streamAuth.logid) {
    streamUrl.searchParams.set('dp-logid', streamAuth.logid);
  }

  let res;
  try {
    res = await fetchWithTimeout(streamUrl.toString(), {
      headers: buildHeaders(request, {
        Accept: '*/*',
        Referer: 'https://www.terabox.com/'
      })
    }, 8000);
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return errorJson(
      isAbort ? 504 : 502,
      isAbort ? 'Upstream stream request timed out' : 'Upstream stream request failed',
      isAbort ? 'upstream_timeout' : 'upstream_error',
      err?.message || (isAbort ? 'timeout' : 'network_error')
    );
  }

  if (!res.ok) {
    return errorJson(502, 'Upstream stream request failed', 'upstream_error', {
      status: res.status
    });
  }

  const playlist = await res.text();
  if (!playlist.includes('#EXTM3U')) {
    return errorJson(502, 'Upstream stream returned non-M3U8 content', 'upstream_non_m3u8', {
      status: res.status,
      preview: playlist.slice(0, 300)
    });
  }
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
  'freeterabox.com',
  'teraboxcdn.com',
  'dm.terabox.app',
  'dm.1024tera.com',
  'terasharelink.com',
  'terafileshare.com',
  'teraboxlink.com',
  'teraboxshare.com',
  'terasharefile.com',
  'teraboxurl.com',
  
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
    return badRequest('Missing url param', ['url']);
  }

  // SSRF protection: only allow TeraBox domains
  if (!isAllowedSegmentUrl(targetUrl)) {
    return errorJson(403, 'Invalid segment URL: only TeraBox domains allowed', 'invalid_segment_url');
  }

  const forwardHeaders = {};
  const range = request.headers.get('Range');
  if (range) forwardHeaders.Range = range;
  const ifRange = request.headers.get('If-Range');
  if (ifRange) forwardHeaders['If-Range'] = ifRange;
  const ifModified = request.headers.get('If-Modified-Since');
  if (ifModified) forwardHeaders['If-Modified-Since'] = ifModified;
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch) forwardHeaders['If-None-Match'] = ifNoneMatch;
  const acceptEncoding = request.headers.get('Accept-Encoding');
  if (acceptEncoding) forwardHeaders['Accept-Encoding'] = acceptEncoding;

  let res;
  try {
    res = await fetchWithTimeout(targetUrl, {
      headers: buildHeaders(request, {
        Referer: 'https://www.terabox.com/',
        ...forwardHeaders
      })
    }, 8000);
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return errorJson(
      isAbort ? 504 : 502,
      isAbort ? 'Upstream segment request timed out' : 'Upstream segment request failed',
      isAbort ? 'upstream_timeout' : 'upstream_error',
      err?.message || (isAbort ? 'timeout' : 'network_error')
    );
  }

  const responseHeaders = new Headers({
    'Content-Type': res.headers.get('content-type') || 'video/mp2t',
    'Cache-Control': 'no-store'
  });
  const passthroughHeaders = [
    'Content-Range',
    'Accept-Ranges',
    'Content-Length',
    'ETag',
    'Last-Modified'
  ];
  passthroughHeaders.forEach((h) => {
    const v = res.headers.get(h);
    if (v) responseHeaders.set(h, v);
  });

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders
  });
}

/**
 * Handle lookup mode - query D1 database directly without hitting upstream
 * Supports lookup by share ID (surl) or file ID (fid)
 */
export async function handleLookup(request, params, env) {
  const surl = normalizeSurl(params.get('surl'));
  const fid = params.get('fid');

  if (!surl && !fid) {
    return badRequest('Missing surl or fid parameter', ['surl', 'fid']);
  }
  if (surl && !isValidSurl(surl)) {
    return badRequest('Invalid surl format');
  }
  if (fid && !/^\d+$/.test(fid)) {
    return badRequest('Invalid fid format');
  }

  if (!env.sharedfile) {
    return errorJson(503, 'D1 database not configured', 'd1_unavailable');
  }

  try {
    // Lookup by file ID
    if (fid) {
      const file = await env.sharedfile
        .prepare('SELECT * FROM media_files WHERE fs_id = ?')
        .bind(fid)
        .first();

      if (!file) {
        return errorJson(404, 'File not found', 'not_found', { fid });
      }

      // Get thumbnails for this file
      const thumbs = await env.sharedfile
        .prepare('SELECT url, thumbnail_type FROM thumbnails WHERE fs_id = ?')
        .bind(fid)
        .all();

      const thumbsObj = {};
      const origin = new URL(request.url).origin;
      thumbs.results.forEach(t => {
        thumbsObj[t.thumbnail_type] = getProxyThumbnailUrl(origin, fid, t.thumbnail_type, file.share_id);
      });

      const thumbUrl = thumbsObj.url3 || thumbsObj.url2 || thumbsObj.url1 || null;

      return Response.json({
        source: 'd1',
        ...(!file.dlink && { note: 'dlink requires valid TeraBox cookies to download' }),
        data: { ...file, thumb: thumbUrl, thumbs: thumbsObj }
      });
    }

    // Lookup by share ID
    const shareData = await getShareFromDb(env.sharedfile, surl);

    if (!shareData) {
      return errorJson(404, 'Share not found in D1. Use mode=resolve first.', 'not_found', { surl });
    }

    const rewrittenShareData = rewriteResponseThumbnails(shareData, request.url, surl);
    const hasDlink = rewrittenShareData.list?.some(f => f.dlink) || false;
    return Response.json({
      source: 'd1',
      ...(!hasDlink && { note: 'dlink requires valid TeraBox cookies to download' }),
      data: rewrittenShareData
    });
  } catch (err) {
    console.error('D1 lookup error:', err);
    return errorJson(500, 'Database query failed', 'db_error', err?.message || 'unknown');
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
    return errorJson(503, 'D1 database not configured', 'd1_unavailable');
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
  shareId = normalizeSurl(shareId);
  if (!shareId) return badRequest('Missing share_id');
  if (!isValidSurl(shareId)) return badRequest('Invalid share_id format');
  const missing = requireD1(env);
  if (missing) return missing;

  const share = await env.sharedfile
    .prepare('SELECT * FROM shares WHERE share_id = ?')
    .bind(shareId)
    .first();

  if (!share) {
    return errorJson(404, 'Share not found', 'not_found', { share_id: shareId });
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
  const shareId = normalizeSurl(params.get('share_id')?.trim());
  if (shareId && !isValidSurl(shareId)) return badRequest('Invalid share_id format');
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
  if (!/^\d+$/.test(fsId)) return badRequest('Invalid fs_id format');
  const missing = requireD1(env);
  if (missing) return missing;

  const file = await env.sharedfile
    .prepare('SELECT * FROM media_files WHERE fs_id = ?')
    .bind(fsId)
    .first();

  if (!file) {
    return errorJson(404, 'File not found', 'not_found', { fs_id: fsId });
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
  if (fsId && !/^\d+$/.test(fsId)) return badRequest('Invalid fs_id format');
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
  const missing = requireD1(env);
  if (missing) return missing;

  const surl = normalizeSurl(params.get('surl'));
  if (!surl) return badRequest('Missing surl');
  if (!isValidSurl(surl)) return badRequest('Invalid surl format');

  try {
    const shareData = await getShareFromDb(env.sharedfile, surl);
    const record = buildResolvedRecordFromDb(surl, shareData, request.url);
    if (!record) {
      return errorJson(404, 'Cached entry not found', 'not_found', { surl });
    }
    return Response.json({ surl, data: record });
  } catch (err) {
    return errorJson(500, 'Cached entry lookup failed', 'db_error', err?.message || 'unknown');
  }
}

export async function handleThumbnail(request, params, env) {
  const fid = params.get('fid');
  const size = params.get('size') || 'url3'; // url3 is typically the highest resolution (850x580)
  let surl = normalizeSurl(params.get('surl'));

  if (!fid) {
    return badRequest('Missing fid parameter', ['fid']);
  }
  if (!/^\d+$/.test(fid)) {
    return badRequest('Invalid fid format');
  }

  if (!env.sharedfile) {
    return errorJson(503, 'D1 database not configured', 'd1_unavailable');
  }

  // 1. Try to find the share_id (surl) from the database if not provided
  if (!surl) {
    try {
      const row = await env.sharedfile
        .prepare('SELECT share_id FROM media_files WHERE fs_id = ?')
        .bind(fid)
        .first();
      if (row) {
        surl = row.share_id;
      }
    } catch (err) {
      console.error('Database query error looking up share_id:', err);
    }
  }

  // 2. Helper function to fetch the image from a signed URL and return it
  const fetchAndServeImage = async (imgUrl) => {
    const res = await fetchWithTimeout(imgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.terabox.com/'
      }
    }, 6000);

    if (res.ok) {
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      // Return the image data with caching headers to cache on CDN
      return new Response(res.body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000', // 1 year cache
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    return null;
  };

  // 3. Try fetching using the cached thumbnail URL in D1 first (preferring highest quality: url3 > url2 > url1 > icon)
  let cachedUrl = null;
  try {
    const rows = await env.sharedfile
      .prepare('SELECT url, thumbnail_type FROM thumbnails WHERE fs_id = ?')
      .bind(fid)
      .all();
    
    if (rows?.results && rows.results.length > 0) {
      const thumbsMap = {};
      rows.results.forEach(r => {
        thumbsMap[r.thumbnail_type] = r.url;
      });
      cachedUrl = thumbsMap.url3 || thumbsMap.url2 || thumbsMap.url1 || thumbsMap.icon;
    }
  } catch (err) {
    console.error('Database query error looking up thumbnail:', err);
  }

  if (cachedUrl) {
    try {
      const response = await fetchAndServeImage(cachedUrl);
      if (response) {
        return response;
      }
      console.log(`[handleThumbnail] Cached thumbnail URL for fid ${fid} expired or invalid. Re-resolving share.`);
    } catch (err) {
      console.error('Error fetching cached thumbnail image:', err);
    }
  }

  // 4. If not found or expired, we need to resolve from upstream to refresh the signed URLs
  if (!surl) {
    return errorJson(404, 'Thumbnail not cached and associated surl not found. Please resolve the share first.', 'not_found');
  }

  // Trigger handleResolve to refresh the cache in D1
  console.log(`[handleThumbnail] Triggering live resolve for surl ${surl} to refresh thumbnails.`);
  const resolveParams = new URLSearchParams();
  resolveParams.set('surl', surl);
  resolveParams.set('refresh', '1');
  resolveParams.set('raw', '1');

  const resolveRes = await handleResolve(request, resolveParams, env);
  if (!resolveRes.ok) {
    return resolveRes; // Return the resolve error (e.g. share deleted / verify needed)
  }

  // 5. Query D1 again for the newly resolved signed URL and pick the best one
  let freshUrl = null;
  try {
    const rows = await env.sharedfile
      .prepare('SELECT url, thumbnail_type FROM thumbnails WHERE fs_id = ?')
      .bind(fid)
      .all();
    
    if (rows?.results && rows.results.length > 0) {
      const thumbsMap = {};
      rows.results.forEach(r => {
        thumbsMap[r.thumbnail_type] = r.url;
      });
      freshUrl = thumbsMap.url3 || thumbsMap.url2 || thumbsMap.url1 || thumbsMap.icon;
    }
  } catch (err) {
    console.error('Database query error looking up fresh thumbnail:', err);
  }

  if (freshUrl) {
    try {
      const response = await fetchAndServeImage(freshUrl);
      if (response) {
        return response;
      }
    } catch (err) {
      console.error('Error fetching fresh thumbnail image:', err);
    }
  }

  return errorJson(502, 'Failed to fetch thumbnail image from upstream', 'upstream_image_error');
}

