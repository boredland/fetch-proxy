# Fetch Proxy

A lightweight HTTP proxy for fetching web pages from servers that block datacenter IPs or have broken SSL certificates. Useful as a fallback for sources that reject direct requests from CI / serverless platforms — and, via an optional FlareSolverr sidecar, for sources gated behind Cloudflare's "Just a moment…" interactive challenge.

Built on [Bun](https://bun.com) + [Elysia](https://elysiajs.com), with an interactive [Scalar](https://scalar.com) API reference served at **`/docs`**.

## Running

### Plain proxy only (no CF-challenge support)

```bash
docker build -t fetch-proxy .
docker run -p 3000:3000 -e AUTH_TOKEN=your-secret fetch-proxy
```

### Proxy + FlareSolverr sidecar (recommended)

```bash
AUTH_TOKEN=your-secret docker compose up -d
```

The compose stack starts two services:
- `fetch-proxy` on `:3000` — public entry point, takes `?url=` requests
- `flaresolverr` — internal-only headless-Chromium service that the proxy auto-invokes when it detects a Cloudflare interactive challenge

In Dokploy: import `docker-compose.yml` as a Compose service, set `AUTH_TOKEN` as a stack secret.

### Local (no Docker)

```bash
npm install
AUTH_TOKEN=your-secret npm start
```

## Configuration

All via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `AUTH_TOKEN` | _(unset)_ | If set, requests must send `Authorization: Bearer <token>` |
| `FLARESOLVERR_URL` | _(unset)_ | FlareSolverr `/v1` base URL; enables the CF-challenge fallback |
| `FLARESOLVERR_TIMEOUT_MS` | `60000` | Max time FlareSolverr may spend solving a challenge |
| `AUTO_FALLBACK` | _(unset)_ | Set to `1` to auto-escalate every request (plain → FlareSolverr → render) when a response looks blocked. Per-request `?auto=` overrides it. |
| `ADBLOCK` | `1` (on) | Ad/cookie/tracker blocking ([uBO-style filter lists](https://github.com/ghostery/adblocker)) on rendered pages. Set to `0` to disable. Per-request `?block=0` overrides it. |
| `ADBLOCK_LISTS` | cookie + ads + tracking | Comma-separated filter-list URLs to override the defaults (EasyList Cookie List, uBO cookie annoyances, EasyList, EasyPrivacy). |

## API reference

An interactive Scalar reference (generated from the route schemas) is served at:

```
GET /docs        # Scalar UI
GET /docs/json   # raw OpenAPI 3.0 spec
```

Both are public — the `AUTH_TOKEN` guard only protects the proxy endpoints.

## Usage

```
GET /?url=https://example.com
Authorization: Bearer <AUTH_TOKEN>
```

Returns the fetched page content with the original status code and content-type.

The caller's HTTP method and request body are mirrored upstream, so form
`POST`s work too (the target's `?url=` still goes in the query string):

```
POST /?url=https://example.com/search
Authorization: Bearer <AUTH_TOKEN>
Content-Type: application/x-www-form-urlencoded

field=value&other=value
```

`Content-Type` is the only request header forwarded; the `User-Agent` is
always replaced with a Chrome UA (the reason callers reach for the proxy).

### Query parameters

- `?url=` **(required)** — the target URL to fetch.
- `?solve=1` — force the FlareSolverr path even when the cheap CF heuristic doesn't fire (e.g. a large 403 page rendered inside the site's own shell with no `cf-chl_` markers).
- `?render=1` — return the page rendered by a stealth headless Chromium (masks `navigator.webdriver`, `window.chrome`, plugins, etc.). For JS-rendered SPAs that serve a bot-fallback to anything headless-looking. Keeps the browser on the proxy's IP so callers need no browser of their own.
- `?wait=<ms>` — with `render=1`, how long to let the SPA's XHR content settle (default `6000`, max `30000`).
- `?auto=1` — **auto-escalate** when a response looks blocked: plain fetch → FlareSolverr → stealth render, returning the first tier that isn't blocked (falls back to the real upstream response if none succeed). "Blocked" = a `403`/`429`/`503`, or a small page matching a known anti-bot wall (Cloudflare, Akamai, PerimeterX, Incapsula, captcha/JS walls). Set `AUTO_FALLBACK=1` to make this the default and use `?auto=0` to opt out per request.
- `?block=0` — disable **ad/cookie/tracker blocking** for this render. On by default: rendered pages run through [`@ghostery/adblocker-playwright`](https://github.com/ghostery/adblocker) with uBO-style filter lists (cookie-banner annoyances + ads + tracking), which removes most consent banners at the source and makes renders faster/cleaner. Only affects `render` (the plain-fetch and FlareSolverr paths can't run a blocker). Configure lists via `ADBLOCK_LISTS`, disable globally via `ADBLOCK=0`.
- `?format=md` — return the page as **Markdown** instead of raw HTML. [Readability](https://github.com/mozilla/readability) extracts the main article (dropping nav/ads/boilerplate and cookie-consent/CMP banners so they aren't mistaken for the content), then [Turndown](https://github.com/mixmark-io/turndown) (+ GFM tables) converts it, with relative links/images resolved to absolute URLs. Composes with `render=1` and the FlareSolverr fallback — whatever HTML the proxy obtains is converted. Non-HTML responses (JSON, images, downloads) pass through untouched. Returns `content-type: text/markdown`.

```
GET /?url=https://example.com&format=md
Authorization: Bearer <AUTH_TOKEN>
```

**Request flow:**

1. Plain `fetch()` with a Chrome User-Agent — handles datacenter-IP blocks and broken TLS chains.
2. If the response looks like a CF interactive challenge (403/503 + "Just a moment…" body) **and** `FLARESOLVERR_URL` is set, retry via FlareSolverr's `/v1` endpoint. FlareSolverr renders the page in a headless Chromium, solves the JS proof-of-work, and returns the resolved HTML.
3. Otherwise pass the original response through.
4. With `?auto=1` (or `AUTO_FALLBACK=1`), if a tier's response still looks blocked, escalate to the next one (plain → FlareSolverr → stealth render); the first non-blocked result wins, else the original upstream response is returned.
5. If `format=md` was requested and the result is HTML, convert it to Markdown before returning.

TLS verification is disabled on the plain-fetch path (per-request `tls: { rejectUnauthorized: false }`) to handle servers with incomplete certificate chains.
