import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);

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

  let contentHtml = document.body?.innerHTML ?? withBase;
  let title = "";
  try {
    const article = new Readability(document).parse();
    if (article?.content) {
      contentHtml = article.content;
      title = article.title?.trim() ?? "";
    }
  } catch {
    // Non-article page — keep the full-body fallback above.
  }

  const md = turndown.turndown(contentHtml).trim();
  return title ? `# ${title}\n\n${md}\n` : `${md}\n`;
}
