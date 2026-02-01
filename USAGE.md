# TBX-Proxy API Usage Guide

A simple guide to using the TeraBox proxy API. All requests are HTTP GET requests with CORS support.

## Base URL

```
https://tbx-proxy.shakir-ansarii075.workers.dev/
```

---

## Quick Start

### 1. Get Share Metadata (Resolve)

First, extract and cache the file metadata from a TeraBox share.

```bash
curl "https://tbx-proxy.shakir-ansarii075.workers.dev/?mode=resolve&surl=YOUR_SHORT_URL"
```

**Response:**
```json
{
  "source": "live",
  "data": {
    "name": "video.mp4",
    "size": 168800237,
    "thumb": "https://...",
    "dlink": "https://...",
    "fid": "511133506523791",
    "uk": "4401146149342",
    "shareid": "10524102871"
  }
}
```

---

### 2. Stream the Video (Get M3U8)

Once resolved, get the M3U8 playlist URL for streaming.

```bash
curl "https://tbx-proxy.shakir-ansarii075.workers.dev/?mode=stream&surl=YOUR_SHORT_URL"
```

**Response:** M3U8 playlist content (can be used with VLC, HLS.js, etc.)

---

## All Modes

| Mode | Purpose | Required Params |
|------|---------|-----------------|
| `resolve` | Extract & cache metadata | `surl` |
| `lookup` | Query D1 cache (fast) | `surl` or `fid` |
| `stream` | Get M3U8 playlist | `surl` |
| `page` | Fetch TeraBox HTML page | `surl` |
| `api` | Direct API call | `jsToken`, `shorturl` |
| `segment` | Proxy video segments | `url` |
| `health` | Service health check | none |
| `metrics` | View usage metrics | none |

---

## Mode: `resolve` ⭐ Start Here

Extracts file metadata and caches in KV (7 days) + D1 (permanent).

**Required:**
- `surl` - TeraBox short URL (e.g., `abc123xyz`)

**Optional:**
- `refresh=1` - Bypass all caches, fetch fresh from TeraBox
- `raw=1` - Return full upstream data (checks D1 cache first)

**Cache Behavior:**
| Query | Cache Check | Speed |
|-------|-------------|-------|
| `?mode=resolve&surl=...` | KV → Upstream | ~500ms first, ~5ms cached |
| `?mode=resolve&surl=...&raw=1` | D1 → Upstream | ~10ms cached |
| `?mode=resolve&surl=...&refresh=1` | None → Upstream | ~1-2s always |

**Examples:**
```bash
# First time - fetches from TeraBox and caches
curl ".../?mode=resolve&surl=abc123"
# Response: {"source": "live", "data": {...}}

# Second time - returns from KV cache
curl ".../?mode=resolve&surl=abc123"
# Response: {"source": "kv", "data": {...}}

# Get full data from D1 cache
curl ".../?mode=resolve&surl=abc123&raw=1"
# Response: {"source": "d1", "data": {...}}

# Force fresh fetch
curl ".../?mode=resolve&surl=abc123&refresh=1"
# Response: {"source": "live", ...}
```

---

## Mode: `lookup` 🚀 Fastest

Query D1 database directly. No upstream calls. Instant response.

**Parameters:**
- `surl` - Lookup by share ID
- `fid` - Lookup by file ID

**Examples:**
```bash
# Lookup by share
curl ".../?mode=lookup&surl=abc123"

# Lookup by file ID
curl ".../?mode=lookup&fid=511133506523791"
```

**Response:**
```json
{
  "source": "d1",
  "data": {
    "share_id": "abc123",
    "title": "...",
    "list": [{ "fs_id": "...", "server_filename": "...", "thumbs": {...} }]
  }
}
```

**Use Cases:**
- Building dashboards showing cached files
- Searching previously resolved shares
- Quick file info display without API calls

---

## Mode: `stream`

Returns M3U8 playlist for video playback. **Requires calling `resolve` first.**

**Required:**
- `surl` - Same short URL from resolve

**Optional:**
- `type` - Video quality (default: `M3U8_AUTO_360`)
  - `M3U8_AUTO_360` - Auto quality (recommended)
  - `M3U8_AUTO_720` - Higher quality

**Example:**
```bash
curl ".../?mode=stream&surl=abc123"
```

---

## Mode: `segment`

Proxies video segments. Called automatically by M3U8 playlist.

**Security:** Only allows TeraBox domains (SSRF protected).

**Allowed Domains:**
`terabox.com`, `terabox.app`, `1024tera.com`, `1024terabox.com`, `teraboxcdn.com`, `terasharelink.com`, `terafileshare.com`, `teraboxlink.com`, `teraboxshare.com`

---

## Mode: `health` & `metrics`

```bash
# Health check
curl ".../?mode=health"

# Usage metrics
curl ".../?mode=metrics"
```

**Metrics Response:**
```json
{
  "totalRequests": 1234,
  "requestsByMode": {"resolve": 500, "stream": 400, ...},
  "cacheHits": 800,
  "cacheMisses": 200,
  "cacheHitRate": "80.00%",
  "responseTimes": {"resolve": {"average": 450, "min": 5, "max": 2000}}
}
```

---

## Common Use Cases

### Stream Video in Browser

```bash
# Step 1: Get metadata and cache it
curl ".../?mode=resolve&surl=abc123"

# Step 2: Use M3U8 URL in player
M3U8_URL="https://tbx-proxy.shakir-ansarii075.workers.dev/?mode=stream&surl=abc123"

# VLC: vlc "$M3U8_URL"
# mpv: mpv "$M3U8_URL"
```

### Get File Info (Fast)

```bash
# Use lookup for cached data (instant)
curl ".../?mode=lookup&surl=abc123" | jq '.data.list[0] | {name: .server_filename, size}'
```

### Refresh Stale Data

```bash
curl ".../?mode=resolve&surl=abc123&refresh=1"
```

### Download with dlink

```bash
DLINK=$(curl -s '.../?mode=resolve&surl=abc123' | jq -r '.data.dlink')
curl -o video.mp4 "$DLINK"
```

---

## Response Sources

| Source | Meaning |
|--------|---------|
| `"source": "live"` | Fresh data from TeraBox |
| `"source": "kv"` | From Cloudflare KV cache (7-day TTL) |
| `"source": "d1"` | From D1 database (permanent) |

---

## Error Codes

| Code | Error | Fix |
|------|-------|-----|
| 400 | Missing parameter | Check required params |
| 403 | Token extraction failed / SSRF blocked | Share may be private or URL not allowed |
| 404 | Not in cache | Call `mode=resolve` first |
| 500 | Incomplete metadata | Try `refresh=1` |
| 502 | Upstream error | TeraBox API may be down |
| 503 | D1 not configured | Check wrangler.toml |

---

## Tips

⚠️ **dlink requires cookies** — The download link won't work without valid TeraBox cookies passed in headers

✅ **Always call `resolve` first** before using `stream`

✅ **Use `lookup` for fast queries** — no upstream calls

✅ **Use `raw=1`** to get full file data with thumbnails

✅ **Use `refresh=1`** if data seems stale

✅ **M3U8 segments are auto-proxied** through the worker

✅ **CORS enabled** — works from browser JavaScript

---

## Need Help?

- **Worker not deployed?** Run `npx wrangler deploy`
- **KV/D1 not configured?** Check `wrangler.toml`
- **Getting 500 errors?** Try with `&raw=1` to see full response
- **Link expired?** Use `&refresh=1` to re-fetch
