/**
 * M3U8 playlist utilities for rewriting and transforming playlist URLs
 */

export function rewriteM3U8(content, request) {
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
