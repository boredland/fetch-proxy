import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { NodeHtmlMarkdown } from "node-html-markdown";

// node-html-markdown over Turndown: it's iterative and built for throughput, so it
// doesn't recurse-per-node into a stack overflow on big rendered DOMs (the Turndown
// failure mode on app shells like Elmhurst), and ships GFM (tables/strikethrough).
const nhm = new NodeHtmlMarkdown({ bulletMarker: "-", codeFence: "```", codeBlockStyle: "fenced" });

// Even so, skip the no-article full-body fallback above this size: converting a
// whole rendered app shell is slow and pointless — bail to raw HTML instead.
const MAX_FALLBACK_HTML = 200_000;

// Exact containers for the common Consent Management Platforms. Removing the whole
// subtree (overlay + underlay) is safe — these ids are vendor-owned.
const CONSENT_SELECTORS = [
  "#onetrust-consent-sdk",
  "#CybotCookiebotDialog",
  "#CybotCookiebotDialogBodyUnderlay",
  "#usercentrics-root",
  "#usercentrics-cmp-ui",
  "#cookiescript_injected",
  "#cookie-law-info-bar",
  "#didomi-host",
  "#BorlabsCookieBox",
  "#cookieModal",
  ".cmplz-cookiebanner",
  ".fc-consent-root",
  ".qc-cmp2-container",
  ".cc-window",
  ".klaro",
].join(",");

// Heuristic match on an element's id / class / aria-label for banners that don't use
// a known vendor id. Scoped to consent-specific phrasings (not the bare word "cookie",
// which appears in legitimate "cookie policy" content) plus named CMP vendors.
const CONSENT_RE =
  /cookie[-_ ]?(banner|consent|notice|bar|layer|law|box|dialog|popup|wall|hint|disclaimer|modal|info|tool|settings|msg|message|prompt|gate|compliance|optin)|consent[-_ ]?(banner|manager|management|layer|popup|dialog|overlay|prompt)|gdpr|usercentrics|onetrust|cookiebot|borlabs|didomi|sourcepoint|quantcast|qc-cmp|cmplz|klaro|cookiescript|cookieyes|cli-modal|cookie-law-info|fc-consent/i;

/** Remove cookie-consent / CMP banners so Readability doesn't mistake them for the
 *  page's main content (the City of Frankfurt forms page, for one, renders its
 *  Usercentrics dialog as the largest text block). Mutates the document in place. */
function stripConsent(document: Document): void {
  for (const el of document.querySelectorAll(CONSENT_SELECTORS)) el.remove();
  for (const el of document.querySelectorAll("div,section,aside,dialog,template")) {
    const signature = `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
    if (CONSENT_RE.test(signature)) el.remove();
  }
}

/** Convert a full HTML document to Markdown. Readability extracts the main
 *  article (dropping nav/ads/boilerplate); if the page isn't article-shaped it
 *  falls back to converting the whole body. A `<base>` tag is injected first so
 *  Readability resolves relative links/images to absolute URLs, and cookie-consent
 *  banners are stripped so they don't get mistaken for the main content. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const withBase = /<base[\s>]/i.test(html)
    ? html
    : html.replace(/<head[^>]*>/i, (head) => `${head}<base href="${baseUrl}">`);

  const { document } = parseHTML(withBase);
  stripConsent(document as unknown as Document);
  // Drop non-content/heavy nodes before conversion: on a JS-rendered page the
  // full-body fallback feeds Turndown the whole app shell, and Turndown recurses
  // per node — scripts/styles/inline SVG add the bulk and depth that overflow its
  // stack. They never belong in Markdown anyway.
  for (const el of document.querySelectorAll("script,style,noscript,template,svg,iframe")) {
    el.remove();
  }

  // Capture the fallback body before Readability, which mutates the document.
  const fallbackBody = document.body?.innerHTML ?? withBase;

  let title = "";
  let articleHtml: string | undefined;
  try {
    const article = new Readability(document).parse();
    if (article?.content) {
      articleHtml = article.content;
      title = article.title?.trim() ?? "";
    }
  } catch {
    // Non-article page — fall back below.
  }

  let contentHtml = articleHtml;
  if (contentHtml === undefined) {
    // Readability found no article. Converting a whole rendered body is the slow,
    // stack-blowing path (Turndown recurses per node) and pointless on an app
    // shell — bail so the caller serves the raw HTML instead of hanging.
    if (fallbackBody.length > MAX_FALLBACK_HTML) {
      throw new Error(
        `no readable article and body too large (${fallbackBody.length} chars) for markdown`,
      );
    }
    contentHtml = fallbackBody;
  }

  const md = nhm.translate(contentHtml).trim();
  return title ? `# ${title}\n\n${md}\n` : `${md}\n`;
}
