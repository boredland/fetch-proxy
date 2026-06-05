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

/** Convert a full HTML document to Markdown. Readability extracts the main
 *  article (dropping nav/ads/boilerplate); if the page isn't article-shaped it
 *  falls back to converting the whole body. A `<base>` tag is injected first so
 *  Readability resolves relative links/images to absolute URLs. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const withBase = /<base[\s>]/i.test(html)
    ? html
    : html.replace(/<head[^>]*>/i, (head) => `${head}<base href="${baseUrl}">`);

  const { document } = parseHTML(withBase);

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
