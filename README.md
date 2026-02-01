# tbx-proxy

A Cloudflare Workers proxy for TeraBox file sharing. This service provides multiple access modes to fetch, stream, and resolve TeraBox shares with metadata caching via Cloudflare KV and D1 database.

## Features

- **Page Mode**: Fetch TeraBox share pages
- **API Mode**: Direct API calls with token-based authentication
- **Resolve Mode**: Extract file metadata and cache in KV + D1
- **Stream Mode**: Get M3U8 playlists for video streaming
- **Segment Mode**: Proxy video segments (with SSRF protection)
- **Lookup Mode**: Query cached D1 data without hitting upstream
- **CORS Support**: Full cross-origin request support
- **Metrics**: Built-in request tracking and performance metrics

## Project Structure

```
src/
├── index.js       # Main entry point and request router
├── handlers.js    # Request handlers for all modes
├── utils.js       # Utility functions (headers, CORS, validation)
├── db.js          # D1 database operations (batched)
├── m3u8.js        # M3U8 playlist processing
└── metrics.js     # Metrics collection and tracking
```

### Module Overview

#### `index.js`
Main Cloudflare Worker handler that routes requests based on the `mode` query parameter. Includes CORS preflight handling and non-blocking metrics via `waitUntil()`.

#### `handlers.js`
Contains six handler functions:
- `handlePage()` - Fetches share pages from TeraBox
- `handleApi()` - Makes manual API calls with jsToken
- `handleResolve()` - Extracts metadata and stores in KV + D1
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
Extracts file metadata from a share and caches it in KV and D1.

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
| `mode=resolve&surl=...` | KV → Upstream → Store in KV + D1 |
| `mode=resolve&surl=...&raw=1` | D1 → Upstream → Store in D1 |
| `mode=resolve&surl=...&refresh=1` | Upstream → Store |

**Response:**
```json
{
  "source": "live|kv|d1",
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
Returns an M3U8 playlist using cached metadata. Requires calling `mode=resolve` first.

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
- `terabox.com`, `terabox.app`, `1024tera.com`, `1024terabox.com`
- `teraboxcdn.com`, `terasharelink.com`, `terafileshare.com`
- `teraboxlink.com`, `teraboxshare.com`

**Response:** Video segment data

---

#### Mode: `health`
Returns service health status and metrics summary.

```
GET /?mode=health
```

---

#### Mode: `metrics`
Returns detailed metrics about requests, cache hits, and response times.

```
GET /?mode=metrics
```

---

## Setup & Deployment

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed
- Cloudflare account with Workers enabled
- KV namespace and D1 database created

### Configuration

Update `wrangler.toml`:

```toml
name = "tbx-proxy"
main = "src/index.js"
compatibility_date = "2024-01-01"

kv_namespaces = [
  { binding = "SHARE_KV", id = "YOUR_KV_NAMESPACE_ID" }
]

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

All errors return JSON responses with CORS headers:

```json
{
  "error": "Error message",
  "required": ["param1", "param2"]
}
```

**Common Status Codes:**
- `400` - Bad Request (missing or invalid parameters)
- `403` - Forbidden (failed to extract token or SSRF blocked)
- `404` - Not Found (share not in cache)
- `500` - Internal Server Error
- `502` - Bad Gateway (upstream error)
- `503` - Service Unavailable (D1 not configured)

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