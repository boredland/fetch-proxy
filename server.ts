import { openapi } from "@elysiajs/openapi";
import { Elysia, t } from "elysia";
import type { Browser, BrowserContext } from "playwright-core";
import { chromium } from "playwright-core";
import { enableBlocking } from "./adblock.ts";
import { htmlToMarkdown } from "./markdown.ts";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PORT = Number(process.env.PORT || 3000);
// Optional sidecar FlareSolverr (https://github.com/FlareSolverr/FlareSolverr) —
// when set, requests that come back as a Cloudflare "Just a moment…" challenge
// are retried through a headless Chromium that can solve it. Provision via
// docker-compose.yml in this directory.
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "";
const FLARESOLVERR_TIMEOUT_MS = Number(process.env.FLARESOLVERR_TIMEOUT_MS || 60000);
// When on, every request auto-escalates (plain -> FlareSolverr -> stealth render)
// if a tier comes back looking blocked. Callers can still override per-request
// with `?auto=1` / `?auto=0`.
const AUTO_FALLBACK = process.env.AUTO_FALLBACK === "1";

// Resilience caps. The proxy is fronted by a CDN (Cloudflare/Traefik) whose
// origin timeout is ~100s — past that the caller gets an opaque 524 instead of a
// real status. So every upstream op is bounded, and the whole request is bounded
// by REQUEST_BUDGET_MS (< the CDN cutoff): we'd rather return our own 504/502
// (which clients retry) than let the connection time out under the CDN.
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000); // tier-1 plain fetch
const REQUEST_BUDGET_MS = Number(process.env.REQUEST_BUDGET_MS || 90000); // whole request
// The hourly scrape rotation hits the proxy in bursts; many parallel renders
// thrash one shared Chromium. Cap concurrent stealth renders — excess ones queue.
const RENDER_CONCURRENCY = Number(process.env.RENDER_CONCURRENCY || 3);

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const asBuffer = (b: Buffer | string): Buffer => (typeof b === "string" ? Buffer.from(b, "utf8") : b);

// Request headers we never forward to the target. The UA is always replaced with
// CHROME_UA (the whole point of the proxy); `host`/`content-length` are recomputed
// by fetch from the target URL and body; `authorization` is the proxy's OWN bearer
// token (see the auth guard) — forwarding it would leak our credential to every
// target; `accept-encoding` is dropped so fetch negotiates compression and we return
// already-decoded bytes; the rest are hop-by-hop or proxy/CDN trace headers that
// describe the proxy hop, not the caller's request.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "user-agent",
  "authorization",
  "content-length",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
]);

/** Forward the caller's request headers to the target, minus the proxy-hop headers
 *  in STRIPPED_REQUEST_HEADERS. Callers add the UA separately so CHROME_UA always wins. */
function forwardableHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });
  return headers;
}

/** Primary locale + ordered language list from an Accept-Language header, used to make
 *  the stealth browser present the caller's languages instead of a fixed default. */
function parseAcceptLanguage(header: string | null): { locale: string; languages: string[] } | null {
  const langs = (header ?? "")
    .split(",")
    .map((part) => part.split(";")[0].trim())
    .filter((tag) => tag && tag !== "*");
  return langs.length ? { locale: langs[0], languages: langs } : null;
}

// Common anti-bot interstitials across vendors (Cloudflare, Akamai, PerimeterX/HUMAN,
// Imperva/Incapsula, generic captcha/JS walls). Used to decide whether a tier's
// response is worth escalating past.
const BOT_WALL =
  /just a moment|attention required|cf-chl|__cf_chl|access denied|pardon our interruption|enable javascript (and cookies|to continue)|request unsuccessful\. incapsula|are you (a )?human|verify you are (a )?human|unusual traffic|please verify you|recaptcha|hcaptcha/i;

/** Heuristic for "this response is a block/challenge, not the real page" — drives
 *  auto-escalation. Conservative on purpose: hard block statuses always count, and
 *  vendor wall markers only count on a small body (real content pages that merely
 *  mention "captcha" are large and pass through). A 404 is a real answer, not a
 *  block, so it does not escalate. */
function looksBlocked(status: number, body: Buffer): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  if (body.length > 50_000) return false;
  return BOT_WALL.test(body.subarray(0, 16_384).toString("utf8"));
}

/** Build the upstream passthrough response, converting to Markdown when the
 *  caller asked for it and the payload is actually HTML (non-HTML bodies — JSON,
 *  images, downloads — pass through untouched even with format=md). */
function buildResponse(
  status: number,
  body: Buffer | string,
  contentType: string,
  wantMd: boolean,
  url: string,
): Response {
  if (wantMd && /html/i.test(contentType)) {
    const html = typeof body === "string" ? body : body.toString("utf8");
    // Markdown is a best-effort bonus: Readability/Turndown can throw on a big
    // JS-rendered page (Turndown recurses per node and overflows the stack on a
    // deep app shell). Degrade to the raw HTML rather than failing the request.
    try {
      return new Response(htmlToMarkdown(html, url), {
        status,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    } catch (e) {
      console.warn(`!! markdown conversion failed for ${url}: ${errMessage(e)} — returning raw HTML`);
    }
  }
  return new Response(body as BodyInit, { status, headers: { "content-type": contentType } });
}

// Shared by GET and POST. Optional everywhere so a missing `url` returns our own
// 400 (preserving the original contract) rather than Elysia's 422; the values
// also populate the Scalar reference.
const ProxyQuery = t.Object({
  url: t.Optional(
    t.String({
      description: "Target URL to fetch (required).",
      examples: ["https://example.com"],
    }),
  ),
  solve: t.Optional(
    t.String({
      description: 'Set to "1" to force the FlareSolverr path even when the CF heuristic does not fire.',
      examples: ["1"],
    }),
  ),
  render: t.Optional(
    t.String({
      description: 'Set to "1" to return the page rendered by a stealth headless Chromium.',
      examples: ["1"],
    }),
  ),
  session: t.Optional(
    t.String({
      description:
        'Set to "1" to run a multi-step session: POST a JSON array of {url,method,body,headers} steps; ' +
        "they run in one stealth browser context (shared cookies) and the last step's response is returned. " +
        "For stateful search backends where one request registers a query and another reads it.",
      examples: ["1"],
    }),
  ),
  wait: t.Optional(
    t.String({
      description: "With render=1, ms to let the SPA's XHR content settle (default 6000, max 30000).",
      examples: ["6000"],
    }),
  ),
  format: t.Optional(
    t.String({
      description:
        'Set to "md" to convert the fetched HTML to Markdown (Readability main-content extraction; nav/ads dropped, links absolutized).',
      examples: ["md"],
    }),
  ),
  auto: t.Optional(
    t.String({
      description:
        'Set to "1" to auto-escalate when a response looks blocked: plain fetch -> FlareSolverr -> stealth render, returning the first tier that is not blocked. "0" opts out when AUTO_FALLBACK is on by default.',
      examples: ["1"],
    }),
  ),
  block: t.Optional(
    t.String({
      description:
        'Ad/cookie/tracker blocking (uBO-style filter lists) is on by default for rendered pages; set to "0" to disable it for this request.',
      examples: ["0"],
    }),
  ),
});
type ProxyQuery = typeof ProxyQuery.static;

const app = new Elysia()
  .use(
    openapi({
      path: "/docs",
      // provider defaults to 'scalar'
      documentation: {
        info: {
          title: "fetch-proxy",
          version: "0.0.1",
          description:
            "HTTP proxy for fetching pages from servers that block datacenter IPs or have broken TLS, " +
            "with optional FlareSolverr (Cloudflare challenge) and stealth-render fallbacks.",
        },
      },
    }),
  )
  .guard(
    {
      beforeHandle({ request, set }) {
        if (AUTH_TOKEN && request.headers.get("authorization") !== `Bearer ${AUTH_TOKEN}`) {
          set.status = 401;
          return { error: "unauthorized" };
        }
      },
    },
    (app) =>
      app
        .get("/", ({ request, query }) => handleProxy(request, query), {
          query: ProxyQuery,
          detail: {
            summary: "Proxy-fetch a URL",
            description:
              "Fetches `?url=` with a Chrome UA (TLS verification off). Falls back to FlareSolverr on a " +
              "Cloudflare challenge, or to a stealth Chromium render with `?render=1`. With `?auto=1` it " +
              "auto-escalates plain -> FlareSolverr -> render until a tier returns something that is not blocked.",
          },
        })
        .post(
          "/",
          ({ request, query, body }) => handleProxy(request, query, body as Buffer | undefined),
          {
            query: ProxyQuery,
            // Take the body as raw bytes so arbitrary form/JSON payloads pass through
            // untouched; returning from `parse` skips Elysia's content-type parsers.
            parse: async ({ request }) => {
              const buf = Buffer.from(await request.arrayBuffer());
              return buf.length ? buf : undefined;
            },
            detail: {
              summary: "Proxy-fetch a URL (mirrors the request body)",
              description:
                "Same as GET, but the request body and Content-Type are forwarded upstream so form POSTs work.",
            },
          },
        ),
  )
  .listen({ port: PORT, idleTimeout: 180 }, (server) => {
    console.log(`fetch-proxy listening on :${server.port}`);
    console.log(`scalar docs at http://localhost:${server.port}/docs`);
    if (FLARESOLVERR_URL) console.log(`flaresolverr sidecar: ${FLARESOLVERR_URL}`);
  });

// A single malformed upstream (e.g. Playwright choking on a bad Set-Cookie during a
// browser fetch) must never take the whole proxy down — log and keep serving.
process.on("unhandledRejection", (reason) => console.error(`!! unhandledRejection: ${errMessage(reason)}`));
process.on("uncaughtException", (err) => console.error(`!! uncaughtException: ${errMessage(err)}`));

export type App = typeof app;

async function handleProxy(req: Request, query: ProxyQuery, body?: Buffer): Promise<Response> {
  if (!query.url) return Response.json({ error: "?url= parameter required" }, { status: 400 });
  const url = query.url;
  // Guarantee a response within REQUEST_BUDGET_MS (< the fronting CDN's ~100s 524
  // cutoff): race the work against a deadline that aborts in-flight fetches and
  // returns a structured 504 the caller can retry. Without this a slow target — or
  // a long plain->FlareSolverr->render auto chain — hangs until the CDN 524s opaquely.
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      console.error(`!! budget ${REQUEST_BUDGET_MS}ms exceeded for ${url}`);
      resolve(Response.json({ error: "upstream timeout" }, { status: 504 }));
    }, REQUEST_BUDGET_MS);
  });
  try {
    return await Promise.race([runProxy(req, query, url, ac.signal, body), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function runProxy(
  req: Request,
  query: ProxyQuery,
  url: string,
  signal: AbortSignal,
  body?: Buffer,
): Promise<Response> {
  const forceSolve = query.solve === "1";
  // `render=1` returns the page rendered by a STEALTH headless Chromium (masks the
  // navigator.webdriver / window.chrome / plugins tells). For JS-rendered SPAs that
  // serve a bot-fallback to anything headless-looking (e.g. staatsoper.de) — keeps
  // the browser on the proxy's (residential) IP so callers need no browser of their own.
  const render = query.render === "1";
  // `format=md` converts whatever HTML we end up with (direct, FlareSolverr, or
  // rendered) into Markdown — see buildResponse.
  const wantMd = query.format === "md";
  // Auto-escalation: on by default if AUTO_FALLBACK is set, unless `?auto=0`; or
  // opt in per-request with `?auto=1`.
  const auto = query.auto === "1" || (AUTO_FALLBACK && query.auto !== "0");
  // Ad/cookie/tracker blocking is on by default for rendered pages; `?block=0` opts out.
  const block = query.block !== "0";

  if (render) {
    console.log(`-> RENDER ${url}`);
    try {
      const waitMs = Math.min(Number(query.wait) || 6000, 30000);
      const rendered = await renderStealth(url, req, waitMs, block);
      console.log(`<- ${rendered.status} ${url} (render)`);
      return buildResponse(rendered.status, rendered.body, rendered.contentType, wantMd, url);
    } catch (e) {
      console.error(`!! render ${url}: ${errMessage(e)}`);
      return Response.json({ error: errMessage(e) }, { status: 502 });
    }
  }

  // `session=1` runs a scripted multi-step flow (POST body = JSON array of steps) in one
  // stealth context so cookie-bound session state carries between requests. `url` is only
  // the log/label here; the real targets are the step URLs.
  if (query.session === "1") {
    console.log(`-> SESSION ${url}`);
    try {
      const steps = parseSessionSteps(body);
      const result = await runSession(req, steps, signal);
      console.log(`<- ${result.status} ${url} (session, ${steps.length} steps)`);
      return buildResponse(result.status, result.body, result.contentType, wantMd, url);
    } catch (e) {
      console.error(`!! session ${url}: ${errMessage(e)}`);
      return Response.json({ error: errMessage(e) }, { status: 502 });
    }
  }

  // Mirror the caller's method/body so form POSTs (not just GET fetches) can be
  // proxied, and forward their request headers (language, cookies, referer, …) so the
  // target sees the real request — minus the proxy-hop headers in
  // STRIPPED_REQUEST_HEADERS and the UA, which is always replaced with CHROME_UA.
  const method = req.method || "GET";
  const reqBody = method === "GET" || method === "HEAD" ? undefined : body;

  console.log(`-> ${method} ${url}`);
  try {
    // Step 1: plain fetch with a Chrome UA. Handles the common cases (datacenter-IP
    // blocks, broken TLS chains, anti-bot heuristics that only check headers). TLS
    // verification is disabled per-request to tolerate incomplete certificate chains.
    const upstreamHeaders = { ...forwardableHeaders(req), "User-Agent": CHROME_UA };
    const direct = await fetch(url, {
      method,
      headers: upstreamHeaders,
      body: reqBody as BodyInit | undefined,
      redirect: "follow",
      tls: { rejectUnauthorized: false },
      // Bound the plain fetch: a slow/hung target must not hold the request open
      // until the CDN 524s. Aborts on the per-op timeout or the global budget.
      signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), signal]),
    });
    const directBody = Buffer.from(await direct.arrayBuffer());

    // Best result so far. Each tier below only replaces it on success, so if every
    // escalation also comes back blocked we still return the real upstream response
    // rather than hiding it behind a maintenance/fallback page.
    let best: { status: number; body: Buffer | string; contentType: string } = {
      status: direct.status,
      body: directBody,
      contentType: direct.headers.get("content-type") || "text/html",
    };

    // Tier 2 — FlareSolverr, the Cloudflare *challenge* solver. Fires only on the
    // CF fingerprint or a forced `solve=1` — NOT on every auto-escalation block.
    // FlareSolverr returns the browser-rendered DOM, which for a non-HTML resource
    // (XML sitemap, JSON API) is Chromium's pretty-printer wrapper, not the original
    // document; generic blocks therefore fall through to tier-3 stealth render,
    // which passes non-HTML through raw. CF fingerprint: 403/503 + a small HTML page
    // with "Just a moment…" or the cf-chl_ JS-init markers.
    const cfChallenge = looksLikeCfChallenge(direct.status, directBody);
    if (FLARESOLVERR_URL && (forceSolve || cfChallenge)) {
      const reason = forceSolve ? "forced solve" : "CF challenge";
      console.log(`?? ${reason} on ${method} ${url} — via FlareSolverr`);
      const solved = await solveWithFlareSolverr(url, method, reqBody, signal);
      if (solved) {
        best = { status: solved.status, body: solved.body, contentType: "text/html; charset=utf-8" };
        if (!looksBlocked(solved.status, asBuffer(solved.body))) {
          console.log(`<- ${solved.status} ${url} (flaresolverr)`);
          return buildResponse(best.status, best.body, best.contentType, wantMd, url);
        }
        console.warn(`!! FlareSolverr still blocked ${url}`);
      } else {
        console.warn(`!! FlareSolverr failed to solve ${url}`);
      }
    }

    // Tier 3 — stealth render. Last resort when auto-escalation is on and we still
    // look blocked (e.g. a non-CF bot wall, or no FlareSolverr sidecar configured).
    if (auto && looksBlocked(best.status, asBuffer(best.body))) {
      console.log(`?? auto fallback on ${method} ${url} — via stealth render`);
      try {
        const rendered = await renderStealth(url, req, 6000, block);
        if (!looksBlocked(rendered.status, asBuffer(rendered.body))) {
          console.log(`<- ${rendered.status} ${url} (auto render)`);
          return buildResponse(rendered.status, rendered.body, rendered.contentType, wantMd, url);
        }
        console.warn(`!! stealth render still blocked ${url}`);
      } catch (e) {
        console.warn(`!! auto render failed ${url}: ${errMessage(e)}`);
      }
    }

    console.log(`<- ${best.status} ${url}`);
    return buildResponse(best.status, best.body, best.contentType, wantMd, url);
  } catch (e) {
    console.error(`!! ${url}: ${errMessage(e)}`);
    return Response.json({ error: errMessage(e) }, { status: 502 });
  }
}

// ── Stealth render ───────────────────────────────────────────────────────────
// A shared headless Chromium that masks the standard automation tells. Some sites
// (e.g. staatsoper.de) serve a "maintenance" bot-fallback to anything that looks
// headless; the init script below gets the real page. Verified against staatsoper.de.
let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  return _browser;
}

// Soft concurrency cap on stealth renders. Each render gets its own browser
// context (isolated) but they all share one Chromium process; under the hourly
// scrape burst, too many at once thrash it and slow every render toward the
// budget. Excess renders queue here instead. A soft cap is fine — a small
// transient overshoot under interleaving doesn't matter.
let _renderActive = 0;
const _renderWaiters: Array<() => void> = [];
async function acquireRenderSlot(): Promise<() => void> {
  if (_renderActive >= RENDER_CONCURRENCY) {
    await new Promise<void>((resolve) => _renderWaiters.push(resolve));
  }
  _renderActive++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _renderActive--;
    _renderWaiters.shift()?.();
  };
}

async function renderStealth(
  url: string,
  req: Request,
  waitMs: number,
  block = true,
): Promise<{ status: number; body: string; contentType: string }> {
  const release = await acquireRenderSlot();
  try {
    return await renderStealthInner(url, req, waitMs, block);
  } finally {
    release();
  }
}

// ── Session (multi-step) ──────────────────────────────────────────────────────
// Some search backends are stateful: one request registers a query in a server-side
// session (cookie-bound), a second reads it back. A single stateless proxy call can't
// bridge them. `runSession` runs an ordered list of requests inside ONE stealth browser
// context, issued from INSIDE the loaded page via fetch() — Chromium's own cookie jar
// carries the session across steps — on the proxy's non-blocked IP. The LAST step's
// response is returned.

interface SessionStep {
  url: string;
  method?: string;
  /** JSON body (object/array serialized) or a raw string; sent as request data. */
  body?: unknown;
  headers?: Record<string, string>;
}

function parseSessionSteps(body: Buffer | undefined): SessionStep[] {
  if (!body || body.length === 0) throw new Error("session: request body must be a JSON array of steps");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("session: request body is not valid JSON");
  }
  const steps = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("session: expected a non-empty array of steps");
  return steps.map((raw, i) => {
    const step = raw as SessionStep;
    if (!step || typeof step.url !== "string") throw new Error(`session: step ${i} needs a "url"`);
    return step;
  });
}

interface StepResult {
  status: number;
  body: string;
  contentType: string;
}

async function runSession(req: Request, steps: SessionStep[], signal: AbortSignal): Promise<StepResult> {
  const release = await acquireRenderSlot();
  const ctx = await newStealthContext(req);
  try {
    const page = await ctx.newPage();
    // Load the origin first so in-page fetch() is same-origin (sends cookies, satisfies
    // CORS/referer) and inherits the session the backend sets. Derive it from step 1's URL.
    await page.goto(new URL(steps[0]!.url).origin, { waitUntil: "domcontentloaded", timeout: 45000 });

    let last: StepResult | null = null;
    for (const step of steps) {
      if (signal.aborted) throw new Error("session: aborted (budget exceeded)");
      const method = (step.method ?? (step.body != null ? "POST" : "GET")).toUpperCase();
      const bodyStr =
        step.body == null ? undefined : typeof step.body === "string" ? step.body : JSON.stringify(step.body);
      const jsonDefault = step.body != null && typeof step.body !== "string";
      // Run the request from INSIDE the page: uses Chromium's own networking + cookie jar,
      // so the server-side session carries between steps. (context.request's cookie parser
      // chokes on some hosts' malformed Set-Cookie; the in-page path avoids it entirely.)
      last = await page.evaluate(
        async ([url, method, bodyStr, headers, jsonDefault]) => {
          const h: Record<string, string> = { ...(headers as Record<string, string>) };
          if (jsonDefault && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) {
            h["content-type"] = "application/json";
          }
          const r = await fetch(url as string, {
            method: method as string,
            headers: h,
            body: (bodyStr as string | undefined) ?? undefined,
            credentials: "include",
          });
          return {
            status: r.status,
            body: await r.text(),
            contentType: r.headers.get("content-type") ?? "application/json",
          };
        },
        [step.url, method, bodyStr, step.headers ?? {}, jsonDefault] as const,
      );
    }
    // parseSessionSteps guarantees at least one step, so `last` is always set here.
    return last as StepResult;
  } finally {
    await ctx.close();
    release();
  }
}

/** A fresh stealth browser context matching the caller's Accept-Language. Shared by the
 *  single-shot render and the multi-step session flow so both present the same masked
 *  browser fingerprint on the proxy's IP. */
async function newStealthContext(req: Request): Promise<BrowserContext> {
  const browser = await getBrowser();
  // Honor the caller's Accept-Language so the rendered page — and its navigator.languages
  // tell — matches what a direct fetch would send; fall back to the German default. Only
  // language is derived here: unlike the single-shot fetch, a browser context broadcasts
  // its headers to every subresource origin, so we don't forward cookies/referer wholesale.
  const lang = parseAcceptLanguage(req.headers.get("accept-language")) ?? {
    locale: "de-DE",
    languages: ["de-DE", "de", "en"],
  };
  const ctx = await browser.newContext({
    locale: lang.locale,
    timezoneId: "Europe/Berlin",
    viewport: { width: 1440, height: 900 },
    userAgent: CHROME_UA,
    // Tolerate incomplete certificate chains, matching the plain-fetch path's
    // tls:{rejectUnauthorized:false} — some archive hosts serve a partial chain.
    ignoreHTTPSErrors: true,
  });
  await ctx.addInitScript((languages: string[]) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => languages });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    (window as unknown as { chrome: unknown }).chrome = { runtime: {} };
  }, lang.languages);
  return ctx;
}

async function renderStealthInner(
  url: string,
  req: Request,
  waitMs: number,
  block: boolean,
): Promise<{ status: number; body: string; contentType: string }> {
  const ctx = await newStealthContext(req);
  const page = await ctx.newPage();
  await enableBlocking(page, block);
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Non-HTML resources (XML sitemaps, JSON APIs) must pass through as the raw
    // network body. page.content() returns the live DOM, which for these is
    // Chromium's built-in pretty-printer (the xml-viewer-style wrapper) — valid
    // HTML, but no longer parseable as the original XML/JSON the caller asked for.
    const respContentType = resp?.headers()["content-type"] ?? "";
    if (resp && respContentType && !/html/i.test(respContentType)) {
      return { status: resp.status(), body: await resp.text(), contentType: respContentType };
    }
    if (waitMs) await page.waitForTimeout(waitMs);
    return {
      status: resp ? resp.status() : 200,
      body: await page.content(),
      contentType: "text/html; charset=utf-8",
    };
  } finally {
    await ctx.close();
  }
}

// Cloudflare challenge/interstitial fingerprints. Two shapes occur: the classic
// "Just a moment…" interstitial carries the cf-chl_ / __cf_chl_opt JS-init markers
// near the top; the newer *managed-challenge* variant renders a page titled
// "403 - Forbidden" that inlines fonts/CSS and only loads the
// /cdn-cgi/challenge-platform/ script near the very END of a ~90KB+ body. Both are
// solvable by FlareSolverr. The markers are CF-internal, so a genuine origin 403/503
// (an app-level "forbidden") contains none of them and is never sent to the solver.
const CF_CHALLENGE = /Just a moment\.\.\.|cf-chl_|__cf_chl_opt|\/cdn-cgi\/challenge-platform\//i;
// Challenge pages are HTML interstitials, never huge documents; cap the scan so a
// large real download (which is never a challenge) isn't read end-to-end.
const CF_CHALLENGE_MAX_BYTES = 512_000;

/** Detect a Cloudflare challenge so we know to fall back to FlareSolverr. Keys on the
 *  CF-specific fingerprints above, scanning the WHOLE body — the managed-challenge
 *  script sits at the end, past the head window an earlier version checked, on a body
 *  far larger than the 50KB cap it used (a real CF challenge was being missed on all
 *  three counts). A real "forbidden" response from the origin carries none of these
 *  markers and passes through unchanged. */
function looksLikeCfChallenge(status: number, body: Buffer): boolean {
  if (status !== 403 && status !== 503) return false;
  if (body.length > CF_CHALLENGE_MAX_BYTES) return false;
  return CF_CHALLENGE.test(body.toString("utf8"));
}

async function solveWithFlareSolverr(
  url: string,
  method: string = "GET",
  body?: Buffer,
  signal?: AbortSignal,
): Promise<{ status: number; body: string } | null> {
  try {
    const command =
      method === "POST"
        ? {
            cmd: "request.post",
            url,
            postData: body ? body.toString("utf8") : "",
            maxTimeout: FLARESOLVERR_TIMEOUT_MS,
          }
        : { cmd: "request.get", url, maxTimeout: FLARESOLVERR_TIMEOUT_MS };
    // Bound the call to FlareSolverr by its own maxTimeout (+ a margin) and the
    // global budget, so a hung/queued sidecar can't hold the request open.
    const timeouts = [AbortSignal.timeout(FLARESOLVERR_TIMEOUT_MS + 5000)];
    if (signal) timeouts.push(signal);
    const res = await fetch(`${FLARESOLVERR_URL.replace(/\/$/, "")}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.any(timeouts),
    });
    if (!res.ok) {
      console.warn(`!! flaresolverr http ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      status?: string;
      message?: string;
      solution?: { status?: number; response?: string };
    };
    if (data.status !== "ok" || !data.solution) {
      console.warn(`!! flaresolverr status=${data.status} message=${data.message ?? ""}`);
      return null;
    }
    return {
      status: data.solution.status || 200,
      body: data.solution.response || "",
    };
  } catch (e) {
    console.warn(`!! flaresolverr threw: ${errMessage(e)}`);
    return null;
  }
}
