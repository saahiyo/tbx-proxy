/**
 * Utility functions for URL building, token extraction, and header management
 */

export function extractJsToken(html) {
  return findBetween(html, 'fn%28%22', '%22%29');
}

export function findBetween(str, start, end) {
  const i = str.indexOf(start);
  if (i === -1) return null;
  const j = str.indexOf(end, i + start.length);
  if (j === -1) return null;
  return str.slice(i + start.length, j);
}

export function buildApiUrl(jsToken, shorturl, root) {
  const u = new URL('https://dm.terabox.app/share/list');
  u.searchParams.set('jsToken', jsToken);
  u.searchParams.set('shorturl', shorturl);
  u.searchParams.set('root', root);
  return u.toString();
}

export function buildHeaders(request, extra = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    ...extra
  };
  const cookie = request.headers.get('Cookie');
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export function badRequest(msg, required) {
  return Response.json(
    { error: msg, ...(required ? { required } : {}) },
    { status: 400 }
  );
}

export async function jsonUpstream(res) {
  const ct = res.headers.get('content-type') || '';
  return Response.json(
    ct.includes('application/json')
      ? await res.json()
      : { error: 'Non-JSON response', status: res.status },
    { status: res.status }
  );
}

/**
 * Validate surl format (alphanumeric, 10-30 chars typical)
 */
export function isValidSurl(surl) {
  if (!surl || typeof surl !== 'string') return false;
  // TeraBox surls are typically alphanumeric, 10-30 characters
  return /^[a-zA-Z0-9_-]{6,50}$/.test(surl);
}

/**
 * Standard CORS headers for API responses
 */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cookie'
};

/**
 * Add CORS headers to a response
 */
export function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    headers
  });
}
