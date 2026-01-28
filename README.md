# tbx-proxy

A Cloudflare Workers proxy for TeraBox file sharing. This service provides multiple access modes to fetch, stream, and resolve TeraBox shares with metadata caching via Cloudflare KV.

## Features

- **Page Mode**: Fetch TeraBox share pages
- **API Mode**: Direct API calls with token-based authentication
- **Resolve Mode**: Extract file metadata and cache in Cloudflare KV
- **Stream Mode**: Get M3U8 playlists for video streaming
- **Segment Mode**: Proxy video segments through the worker

## Project Structure

```
src/
├── index.js       # Main entry point and request router
├── handlers.js    # Request handlers for all modes
├── utils.js       # Utility functions (headers, token extraction, etc.)
└── m3u8.js        # M3U8 playlist processing
```

### Module Overview

#### `index.js`
Main Cloudflare Worker handler that routes requests based on the `mode` query parameter.

#### `handlers.js`
Contains five handler functions:
- `handlePage()` - Fetches share pages from TeraBox
- `handleApi()` - Makes manual API calls with jsToken
- `handleResolve()` - Extracts metadata and stores in KV
- `handleStream()` - Returns M3U8 playlists from cached metadata
- `handleSegment()` - Proxies video segment requests

#### `utils.js`
Helper functions:
- `extractJsToken()` - Extracts authentication token from HTML
- `buildApiUrl()` - Constructs TeraBox API URLs
- `buildHeaders()` - Builds request headers with user-agent and cookies
- `badRequest()` - Returns standardized error responses
- `jsonUpstream()` - Handles JSON response parsing

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
Extracts file metadata from a share and caches it in Cloudflare KV.

```
GET /?mode=resolve&surl=<shorturl>[&refresh=1][&raw=1]
```

**Parameters:**
- `surl` (required) - TeraBox short URL
- `refresh` (optional) - Set to `1` to bypass KV cache
- `raw` (optional) - Set to `1` to return raw upstream data

**Response:** JSON object with file metadata:
```json
{
  "source": "live|kv",
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
Proxies video segment requests.

```
GET /?mode=segment&url=<segment_url>
```

**Parameters:**
- `url` (required) - Full segment URL to proxy

**Response:** Video segment data

---

## Setup & Deployment

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed
- Cloudflare account with Workers enabled
- KV namespace created

### Configuration

Update `wrangler.toml`:

```toml
name = "tbx-proxy"
main = "src/index.js"
compatibility_date = "2024-01-01"

kv_namespaces = [
  { binding = "SHARE_KV", id = "YOUR_KV_NAMESPACE_ID" }
]
```

### Deploy

```bash
wrangler deploy
```

## Error Handling

All errors return JSON responses with appropriate HTTP status codes:

```json
{
  "error": "Error message",
  "required": ["param1", "param2"]  // Only for validation errors
}
```

**Common Status Codes:**
- `400` - Bad Request (missing or invalid parameters)
- `403` - Forbidden (failed to extract token)
- `404` - Not Found (share not in KV cache)
- `500` - Internal Server Error
- `502` - Bad Gateway (upstream error)

## Example Workflows

### 1. Stream a Video
```bash
# Step 1: Resolve and cache metadata
curl "https://worker.example.com/?mode=resolve&surl=abc123"

# Step 2: Get M3U8 playlist
curl "https://worker.example.com/?mode=stream&surl=abc123"
```

### 2. Direct API Access
```bash
curl "https://worker.example.com/?mode=api&jsToken=token123&shorturl=abc123"
```

### 3. Get Share Page
```bash
curl "https://worker.example.com/?mode=page&surl=abc123"
```

## Development

### Local Testing

```bash
wrangler dev
```

This starts a local development server at `http://localhost:8787`.

### Testing Modes

```bash
# Test mode parameter validation
curl "http://localhost:8787/"

# Test page mode
curl "http://localhost:8787/?mode=page&surl=test"

# Test missing parameters
curl "http://localhost:8787/?mode=api"
```

## Environment Variables

None required - uses Cloudflare KV binding from `wrangler.toml`.

## License

MIT

## Disclaimer

This proxy is provided for educational purposes. Users are responsible for ensuring compliance with TeraBox's Terms of Service and applicable laws.