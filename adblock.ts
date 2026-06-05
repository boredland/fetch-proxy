import { PlaywrightBlocker } from "@ghostery/adblocker-playwright";

// On by default; ADBLOCK=0 disables it entirely.
const ADBLOCK = process.env.ADBLOCK !== "0";

// Cookie-banner annoyance lists are the headline use case; ads + tracking are
// included because blocking those third-party requests makes renders faster and
// cleaner. Override the whole set with ADBLOCK_LISTS (comma-separated URLs).
const DEFAULT_LISTS = [
  "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
  "https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt",
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
];
const LISTS =
  process.env.ADBLOCK_LISTS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? DEFAULT_LISTS;

// Built once per process and reused across renders. Filter-list fetch failures
// degrade to no blocking rather than failing the render.
let _blocker: Promise<PlaywrightBlocker | null> | null = null;
function buildBlocker(): Promise<PlaywrightBlocker | null> {
  return PlaywrightBlocker.fromLists(fetch, LISTS).then(
    (b) => {
      console.log(`adblocker: loaded ${LISTS.length} filter lists`);
      return b;
    },
    (e) => {
      console.warn(`adblocker: failed to load lists (${e}); rendering without blocking`);
      return null;
    },
  );
}

/** Enable ad/cookie/tracker blocking on a render page (network requests blocked +
 *  cosmetic rules injected). No-op when disabled, when the caller opts out, or when
 *  the lists couldn't be fetched. The Page is cast because the plugin types against
 *  `playwright` while we run on the API-compatible `playwright-core`. */
export async function enableBlocking(page: unknown, enabled = true): Promise<void> {
  if (!ADBLOCK || !enabled) return;
  _blocker ??= buildBlocker();
  const blocker = await _blocker;
  if (blocker) await blocker.enableBlockingInPage(page as never);
}
