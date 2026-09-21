import { describe, expect, test } from "vitest";
import { looksBlocked } from "./server";

// Body shapes that mirror what the real walls look like on the wire. The sizes
// matter: the predicate's behaviour changes across the 50KB generic-marker cap
// and the 512KB Cloudflare cap, so anything smaller wouldn't exercise them.
const filler = (kb: number) => "<div>lorem ipsum ballet course</div>".repeat(Math.ceil((kb * 1024) / 36));

/** The managed-challenge variant documented at CF_CHALLENGE: a ~90KB page titled
 *  "403 - Forbidden" whose only CF marker is the script tag at the very end. */
const managedChallenge = Buffer.from(
  `<html><head><title>403 - Forbidden</title></head><body>${filler(90)}` +
    `<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`,
);

describe("looksBlocked", () => {
  test.each([
    ["401 — origin refusing the proxy's egress IP", 401],
    ["403", 403],
    ["429", 429],
    ["503", 503],
  ])("escalates on %s", (_label, status) => {
    expect(looksBlocked(status, Buffer.from("<html>nope</html>"))).toBe(true);
  });

  test("a 404 is a real answer, not a block", () => {
    expect(looksBlocked(404, Buffer.from("<h1>Not Found</h1>"))).toBe(false);
  });

  test("a 200 page carrying no wall markers passes through", () => {
    expect(looksBlocked(200, Buffer.from("<p>Full-time training - Lower School Dance</p>"))).toBe(false);
  });

  test("small vendor interstitial is a block", () => {
    expect(looksBlocked(200, Buffer.from("<h1>Just a moment...</h1>"))).toBe(true);
  });

  // The three counts on which the managed challenge previously escaped detection:
  // served 200, body over the 50KB generic cap, marker past a 16KB head window.
  test("Cloudflare managed challenge is caught despite its size and trailing marker", () => {
    expect(managedChallenge.length).toBeGreaterThan(50_000);
    expect(looksBlocked(200, managedChallenge)).toBe(true);
  });

  test("Cloudflare markers stop counting past the 512KB cap", () => {
    const huge = Buffer.from(filler(600) + '<script src="/cdn-cgi/challenge-platform/x"></script>');
    expect(huge.length).toBeGreaterThan(512_000);
    expect(looksBlocked(200, huge)).toBe(false);
  });

  // The generic markers are ordinary English, so they must stay bounded to
  // interstitial-sized bodies or real prose about captchas would escalate.
  test("a long article mentioning recaptcha is not a block", () => {
    const article = Buffer.from(`${filler(100)}<p>we dropped our recaptcha and access denied pages</p>`);
    expect(article.length).toBeGreaterThan(50_000);
    expect(looksBlocked(200, article)).toBe(false);
  });

  test("the same wording on an interstitial-sized body is a block", () => {
    expect(looksBlocked(200, Buffer.from("<h1>Access Denied</h1><p>unusual traffic</p>"))).toBe(true);
  });
});
