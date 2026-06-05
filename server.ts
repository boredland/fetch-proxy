import { openapi } from "@elysiajs/openapi";
import { Elysia, t } from "elysia";
import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PORT = Number(process.env.PORT || 3000);
// Optional sidecar FlareSolverr (https://github.com/FlareSolverr/FlareSolverr) —
// when set, requests that come back as a Cloudflare "Just a moment…" challenge
// are retried through a headless Chromium that can solve it. Provision via
// docker-compose.yml in this directory.
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "";
const FLARESOLVERR_TIMEOUT_MS = Number(process.env.FLARESOLVERR_TIMEOUT_MS || 60000);

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
              "Cloudflare challenge, or to a stealth Chromium render with `?render=1`.",
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
  if (!url) return Response.json({ error: "?url= parameter required" }, { status: 400 });

  if (render) {
    console.log(`-> RENDER ${url}`);
    try {
      const waitMs = Math.min(Number(query.wait) || 6000, 30000);
      const rendered = await renderStealth(url, waitMs);
      console.log(`<- ${rendered.status} ${url} (render)`);
      return new Response(rendered.body, {
        status: rendered.status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
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

    // Step 2: if the response is a Cloudflare interactive challenge AND FlareSolverr
    // is available, retry through it. CF challenge fingerprint: 403/503 + a small HTML
    // page containing "Just a moment…" or the cf-chl_ JS-init markers.
    if (FLARESOLVERR_URL && (forceSolve || looksLikeCfChallenge(direct.status, directBody))) {
      console.log(
        `?? ${forceSolve ? "forced solve" : "CF challenge"} on ${method} ${url} — via FlareSolverr`,
      );
      const solved = await solveWithFlareSolverr(url, method, reqBody);
      if (solved) {
        console.log(`<- ${solved.status} ${url} (flaresolverr)`);
        return new Response(solved.body, {
          status: solved.status,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      console.warn(`!! FlareSolverr failed to solve ${url}; returning original 403`);
    }

    console.log(`<- ${direct.status} ${url}`);
    return new Response(directBody, {
      status: direct.status,
      headers: { "content-type": direct.headers.get("content-type") || "text/html" },
    });
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
): Promise<{ status: number; body: string }> {
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
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (waitMs) await page.waitForTimeout(waitMs);
    return { status: resp ? resp.status() : 200, body: await page.content() };
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
