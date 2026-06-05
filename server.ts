import { openapi } from "@elysiajs/openapi";
import { Elysia, t } from "elysia";
import type { Browser } from "playwright-core";
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

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const asBuffer = (b: Buffer | string): Buffer => (typeof b === "string" ? Buffer.from(b, "utf8") : b);

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

export type App = typeof app;

async function handleProxy(req: Request, query: ProxyQuery, body?: Buffer): Promise<Response> {
  const url = query.url;
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
  if (!url) return Response.json({ error: "?url= parameter required" }, { status: 400 });

  if (render) {
    console.log(`-> RENDER ${url}`);
    try {
      const waitMs = Math.min(Number(query.wait) || 6000, 30000);
      const rendered = await renderStealth(url, waitMs, block);
      console.log(`<- ${rendered.status} ${url} (render)`);
      return buildResponse(rendered.status, rendered.body, rendered.contentType, wantMd, url);
    } catch (e) {
      console.error(`!! render ${url}: ${errMessage(e)}`);
      return Response.json({ error: errMessage(e) }, { status: 502 });
    }
  }

  // Mirror the caller's method/body so form POSTs (not just GET fetches) can be
  // proxied. Content-Type is the one request header we forward — the UA is always
  // replaced with CHROME_UA, which is the whole point of the proxy.
  const method = req.method || "GET";
  const reqBody = method === "GET" || method === "HEAD" ? undefined : body;
  const contentType = req.headers.get("content-type");

  console.log(`-> ${method} ${url}`);
  try {
    // Step 1: plain fetch with a Chrome UA. Handles the common cases (datacenter-IP
    // blocks, broken TLS chains, anti-bot heuristics that only check headers). TLS
    // verification is disabled per-request to tolerate incomplete certificate chains.
    const upstreamHeaders: Record<string, string> = { "User-Agent": CHROME_UA };
    if (reqBody && contentType) upstreamHeaders["content-type"] = contentType;
    const direct = await fetch(url, {
      method,
      headers: upstreamHeaders,
      body: reqBody as BodyInit | undefined,
      redirect: "follow",
      tls: { rejectUnauthorized: false },
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
      const solved = await solveWithFlareSolverr(url, method, reqBody);
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
        const rendered = await renderStealth(url, 6000, block);
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

async function renderStealth(
  url: string,
  waitMs: number,
  block = true,
): Promise<{ status: number; body: string; contentType: string }> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1440, height: 900 },
    userAgent: CHROME_UA,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["de-DE", "de", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    (window as unknown as { chrome: unknown }).chrome = { runtime: {} };
  });
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

/** Detect a Cloudflare interactive challenge so we know to fall back to
 *  FlareSolverr. Cheap heuristic: small 403 response containing the JS-init
 *  fingerprint. Bigger 403 pages (real "forbidden" responses from the origin)
 *  pass through unchanged. */
function looksLikeCfChallenge(status: number, body: Buffer): boolean {
  if (status !== 403 && status !== 503) return false;
  if (body.length > 50_000) return false;
  const head = body.subarray(0, Math.min(body.length, 8192)).toString("utf8");
  return /Just a moment\.\.\./i.test(head) || /cf-chl_/i.test(head) || /__cf_chl_opt/i.test(head);
}

async function solveWithFlareSolverr(
  url: string,
  method: string = "GET",
  body?: Buffer,
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
    const res = await fetch(`${FLARESOLVERR_URL.replace(/\/$/, "")}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
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
