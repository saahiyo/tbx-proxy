# tbx-proxy

A Cloudflare Workers proxy for TeraBox file sharing. This service provides multiple access modes to fetch, stream, and resolve TeraBox shares with metadata caching via a D1 database.

## Features

- **Page Mode**: Fetch TeraBox share pages
- **API Mode**: Direct API calls with token-based authentication
- **Resolve Mode**: Extract file metadata and cache in D1
- **Stream Mode**: Get M3U8 playlists for video streaming
- **Segment Mode**: Proxy video segments (with SSRF protection)
- **Lookup Mode**: Query cached D1 data without hitting upstream
- **Admin Analytics & DB Explorer**: Path-based routes to inspect stored data and analytics
- **CORS Support**: Full cross-origin request support

## Project Structure

```
src/
├── index.js       # Main entry point and request router
├── handlers.js    # Request handlers for all modes
├── utils.js       # Utility functions (headers, CORS, validation)
├── db.js          # D1 database operations (batched)
├── m3u8.js        # M3U8 playlist processing
```

### Module Overview

#### `index.js`
Main Cloudflare Worker handler that routes requests based on the `mode` query parameter and handles CORS preflight requests.

#### `handlers.js`
Contains six handler functions:
- `handlePage()` - Fetches share pages from TeraBox
- `handleApi()` - Makes manual API calls with jsToken
- `handleResolve()` - Extracts metadata and stores in D1
- `handleStream()` - Returns M3U8 playlists from cached metadata
- `handleSegment()` - Proxies video segments (SSRF protected)
- `handleLookup()` - Queries D1 database directly

#### `utils.js`
Helper functions:
- `extractJsToken()` - Extracts authentication token from HTML
- `buildApiUrl()` - Constructs TeraBox API URLs
- `buildHeaders()` - Builds request headers with user-agent and cookies
- `badRequest()` - Returns standardized error responses
- `jsonUpstream()` - Handles JSON response parsing
- `isValidSurl()` - Validates short URL format
- `withCors()` - Adds CORS headers to responses

#### `db.js`
D1 database operations with batched inserts for performance:
- `storeUpstreamData()` - Batch saves share + files + thumbnails
- `getShareFromDb()` - Fetches cached share data
- `saveShare()` / `saveMediaFile()` / `saveThumbnails()`

#### `m3u8.js`
- `rewriteM3U8()` - Rewrites M3U8 playlist URLs to proxy through worker

## Usage

### Query Parameters

#### Mode: `page`
Fetches the TeraBox share page.

```
GET /?mode=page&surl=<shorturl>
```

**Parameters:**
- `surl` (required) - TeraBox short URL

**Response:** HTML page content

---

#### Mode: `api`
Makes a direct API call with token and shorturl.

```
GET /?mode=api&jsToken=<token>&shorturl=<shorturl>
```

**Parameters:**
- `jsToken` (required) - JavaScript token for authentication
- `shorturl` (required) - TeraBox short URL

**Response:** JSON metadata from TeraBox API

---

#### Mode: `resolve`
Extracts file metadata from a share and caches it in D1.

```
GET /?mode=resolve&surl=<shorturl>[&refresh=1][&raw=1]
```

**Parameters:**
- `surl` (required) - TeraBox short URL
- `refresh` (optional) - Set to `1` to bypass all caches and fetch fresh
- `raw` (optional) - Set to `1` to return full upstream data (checks D1 first)

**Cache Behavior:**
| Query | Cache Check Order |
|-------|-------------------|
| `mode=resolve&surl=...` | D1 → Upstream → Store in D1 |
| `mode=resolve&surl=...&raw=1` | D1 → Upstream → Store in D1 |
| `mode=resolve&surl=...&refresh=1` | Upstream → Store |

> ℹ️ **Note on `raw=1` Output:** If `raw=1` results in a cache hit (source is `d1`), the raw data is returned in the `"data"` field. If it results in a cache miss (source is `live`), the raw data is returned in the `"upstream"` field.

**Response:**
```json
{
  "source": "live|d1",
  "data": {
    "name": "filename",
    "dlink": "signed_download_link",
    "size": 1024000,
    "time": 1609459200,
    "original_url": "https://terabox.app/s/...",
    "thumb": "thumbnail_url",
    "uk": "user_id",
    "shareid": "share_id",
    "fid": "file_id",
    "stored_at": 1609459200,
    "last_verified": 1609459200
  }
}
```

> ⚠️ **Important:** The `dlink` (download link) requires valid TeraBox cookies to work. Pass cookies in the `Cookie` header when making download requests.

---

#### Mode: `lookup`
Queries the D1 database directly without hitting TeraBox upstream.

```
GET /?mode=lookup&surl=<shorturl>
GET /?mode=lookup&fid=<file_id>
```

**Parameters:**
- `surl` (optional) - TeraBox short URL (share ID)
- `fid` (optional) - File system ID for specific file lookup

**Response:**
```json
{
  "source": "d1",
  "data": { ... }
}
```

---

#### Mode: `stream`
Returns an M3U8 playlist using cached metadata. If the metadata is not yet cached in D1, the worker will automatically resolve and cache it from upstream in the background (though calling `mode=resolve` beforehand is recommended to reduce initial latency).

```
GET /?mode=stream&surl=<shorturl>[&type=<quality>]
```

**Parameters:**
- `surl` (required) - TeraBox short URL
- `type` (optional) - Video quality (default: `M3U8_AUTO_360`)

**Response:** M3U8 playlist with rewritten segment URLs

---

#### Mode: `segment`
Proxies video segment requests. **SSRF protected** — only allows TeraBox domains.

```
GET /?mode=segment&url=<segment_url>
```

**Parameters:**
- `url` (required) - Full segment URL to proxy (must be TeraBox domain)

**Allowed Domains:**
- `terabox.com`, `terabox.app`, `1024tera.com`, `1024terabox.com`, `freeterabox.com`
- `teraboxcdn.com`, `dm.terabox.app`, `dm.1024tera.com`
- `terasharelink.com`, `terafileshare.com`, `terasharefile.com`
- `teraboxlink.com`, `teraboxshare.com`, `teraboxurl.com`

**Response:** Video segment data

---

#### Mode: `health`
Returns service health status.

```
GET /?mode=health
```

---

## Admin Endpoints

The worker exposes a set of path-based admin endpoints to query the database and check operational details.

### Authentication
If `ADMIN_KEY` is configured in `wrangler.toml` (under `[vars]`), requests to any `/admin/*` route must pass the key:
- Via the query parameter `key`: `/admin/overview?key=YOUR_ADMIN_KEY`
- Via the HTTP header `x-admin-key`: `x-admin-key: YOUR_ADMIN_KEY`

### Route List:
- `GET /admin/overview`: Statistics overview (counts of shares, files, thumbnails, and latest 20 shares).
- `GET /admin/shares`: List of shares with pagination. Support query filtering (`q`), sorting (`sort`), and order (`order`).
- `GET /admin/shares/:share_id`: Detailed information for a single share including associated media files.
- `GET /admin/files`: List of files with size filtering (`size_min`/`size_max`), search (`q`), and share ID filtering.
- `GET /admin/files/:fs_id`: Details of a specific media file.
- `GET /admin/thumbnails`: Paginated search of database thumbnail records.
- `GET /admin/analytics/processed`: Operational metrics grouped by day.
- `GET /admin/kv/entry?surl=<surl>`: Direct resolved record query (fetches from D1).

---

## Setup & Deployment

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed
- Cloudflare account with Workers enabled
- D1 database created

### Configuration

Update `wrangler.toml`:

```toml
name = "tbx-proxy"
main = "src/index.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "sharedfile"
database_name = "sharedfile"
database_id = "YOUR_D1_DATABASE_ID"

[observability]
[observability.logs]
enabled = true
```

### D1 Schema

Create tables in your D1 database:

```sql
CREATE TABLE shares (
  share_id TEXT PRIMARY KEY,
  uk TEXT,
  title TEXT,
  server_time INTEGER,
  cfrom_id TEXT,
  errno INTEGER,
  request_id TEXT,
  updated_at DATETIME
);

CREATE TABLE media_files (
  fs_id TEXT PRIMARY KEY,
  share_id TEXT,
  category TEXT,
  isdir INTEGER,
  local_ctime INTEGER,
  local_mtime INTEGER,
  md5 TEXT,
  path TEXT,
  play_forbid INTEGER,
  server_ctime INTEGER,
  server_filename TEXT,
  server_mtime INTEGER,
  size INTEGER,
  is_adult INTEGER,
  cmd5 TEXT,
  dlink TEXT
);

CREATE TABLE thumbnails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fs_id TEXT,
  url TEXT,
  thumbnail_type TEXT
);
```

### Deploy

```bash
npx wrangler deploy
```

## Error Handling

All errors return JSON responses with CORS headers.

**Response Schema:**
```json
{
  "error": "Human readable error description",
  "code": "error_code_string",
  "details": "Optional network or exception details (if available)",
  "required": ["list", "of", "missing", "params"]
}
```

**Common Status Codes & Codes:**
* `400` / `bad_request`: Missing or invalid query parameter.
* `401` / `unauthorized`: Missing or incorrect admin key credential on `/admin` paths.
* `403` / `token_extract_failed` or `invalid_segment_url`: Failed to extract jsToken from share page, or SSRF domain check blocked the segment URL.
* `404` / `not_found`: Database record lookup failed.
* `500` / `incomplete_metadata` or `db_error` or `internal_error`: Missing database columns, query exceptions, or script failures.
* `502` / `upstream_error` or `upstream_non_json` or `upstream_empty`: Upstream TeraBox page/API returned non-2xx status, failed to return JSON, or returned an empty file list.
* `503` / `d1_unavailable`: D1 binding is not configured.
* `504` / `upstream_timeout`: Upstream fetch operation timed out (exceeded 8-second execution limit).

## Example Workflows

### 1. Stream a Video
```bash
# Step 1: Resolve and cache metadata
curl "https://worker.example.com/?mode=resolve&surl=abc123"

# Step 2: Get M3U8 playlist
curl "https://worker.example.com/?mode=stream&surl=abc123"
```

### 2. Query Cached Data (Fast)
```bash
# Get from D1 without hitting upstream
curl "https://worker.example.com/?mode=lookup&surl=abc123"

# Or use resolve with raw (checks D1 first)
curl "https://worker.example.com/?mode=resolve&surl=abc123&raw=1"
```

### 3. Force Fresh Data
```bash
curl "https://worker.example.com/?mode=resolve&surl=abc123&refresh=1"
```

## Development

### Local Testing

```bash
wrangler dev
```

This starts a local development server at `http://localhost:8787`.

## Security Features

- **SSRF Protection**: Segment mode only allows whitelisted TeraBox domains
- **CORS Support**: Proper preflight handling for browser requests
- **Input Validation**: URL format validation for short URLs

## License

MIT

## Disclaimer

This proxy is provided for educational purposes. Users are responsible for ensuring compliance with TeraBox's Terms of Service and applicable laws.
