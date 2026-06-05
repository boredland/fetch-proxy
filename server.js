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

const json = (status, obj) => Response.json(obj, { status });

Bun.serve({
  port: PORT,
  // The ?render=1 path drives a real Chromium (goto up to 45s + settle up to
  // 30s), well past Bun's 10s default. Hold connections open long enough for it.
  idleTimeout: 180,
  async fetch(req) {
    if (AUTH_TOKEN && req.headers.get("authorization") !== `Bearer ${AUTH_TOKEN}`) {
      return json(401, { error: "unauthorized" });
    }

    const params = new URL(req.url).searchParams;
    const url = params.get("url");
    // `&solve=1` forces the FlareSolverr path even when the heuristic doesn't fire —
    // for JS-execution challenges that don't match the cheap CF fingerprint (e.g. a
    // large 403 page rendered inside the site's own shell, with no cf-chl_ markers).
    const forceSolve = params.get("solve") === "1";
    // `&render=1` returns the page rendered by a STEALTH headless Chromium (masks the
    // navigator.webdriver / window.chrome / plugins tells). For JS-rendered SPAs that
    // serve a bot-fallback to anything headless-looking (e.g. staatsoper.de) — keeps
    // the browser on the proxy's (residential) IP so callers need no browser of their
    // own. `&wait=<ms>` lets the SPA's XHR content settle (default 6000).
    const render = params.get("render") === "1";
    if (!url) return json(400, { error: "?url= parameter required" });

    if (render) {
      console.log(`-> RENDER ${url}`);
      try {
        const waitMs = Math.min(Number(params.get("wait")) || 6000, 30000);
        const rendered = await renderStealth(url, waitMs);
        console.log(`<- ${rendered.status} ${url} (render)`);
        return new Response(rendered.body, {
          status: rendered.status,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (e) {
        console.error(`!! render ${url}: ${e.message}`);
        return json(502, { error: e.message });
      }
    }

    // Mirror the caller's method/body so form POSTs (not just GET fetches)
    // can be proxied. Content-Type is the one request header we forward —
    // the UA is always replaced with CHROME_UA, which is the whole point of
    // the proxy.
    const method = req.method || "GET";
    const reqBody =
      method === "GET" || method === "HEAD" ? undefined : Buffer.from(await req.arrayBuffer());
    const contentType = req.headers.get("content-type");

    console.log(`-> ${method} ${url}`);
    try {
      // Step 1: plain fetch with a Chrome UA. Handles the common cases
      // (datacenter-IP blocks, broken TLS chains, anti-bot heuristics that
      // only check headers). TLS verification is disabled per-request to
      // tolerate servers with incomplete certificate chains.
      const upstreamHeaders = { "User-Agent": CHROME_UA };
      if (reqBody && contentType) upstreamHeaders["content-type"] = contentType;
      const direct = await fetch(url, {
        method,
        headers: upstreamHeaders,
        body: reqBody,
        redirect: "follow",
        tls: { rejectUnauthorized: false },
      });
      const directBody = Buffer.from(await direct.arrayBuffer());

      // Step 2: if the response is a Cloudflare interactive challenge AND
      // FlareSolverr is available, retry through it. CF challenge fingerprint:
      // 403 status + a small HTML page containing "Just a moment…" or the
      // cf-chl_ JS-init markers.
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
      console.error(`!! ${url}: ${e.message}`);
      return json(502, { error: e.message });
    }
  },
});

console.log(`fetch-proxy listening on :${PORT}`);
if (FLARESOLVERR_URL) console.log(`flaresolverr sidecar: ${FLARESOLVERR_URL}`);

// ── Stealth render ───────────────────────────────────────────────────────────
// A shared headless Chromium that masks the standard automation tells. Some sites
// (e.g. staatsoper.de) serve a "maintenance" bot-fallback to anything that looks
// headless; the init script below gets the real page. Verified against staatsoper.de.
let _browser = null;
async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  return _browser;
}

async function renderStealth(url, waitMs) {
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
    window.chrome = { runtime: {} };
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
function looksLikeCfChallenge(status, body) {
  if (status !== 403 && status !== 503) return false;
  if (body.length > 50_000) return false;
  const head = body.subarray(0, Math.min(body.length, 8192)).toString("utf8");
  return /Just a moment\.\.\./i.test(head) || /cf-chl_/i.test(head) || /__cf_chl_opt/i.test(head);
}

async function solveWithFlareSolverr(url, method = "GET", body) {
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
    const data = await res.json();
    if (data.status !== "ok" || !data.solution) {
      console.warn(`!! flaresolverr status=${data.status} message=${data.message ?? ""}`);
      return null;
    }
    return {
      status: data.solution.status || 200,
      body: data.solution.response || "",
    };
  } catch (e) {
    console.warn(`!! flaresolverr threw: ${e.message}`);
    return null;
  }
}
