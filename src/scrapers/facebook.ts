import { Page } from 'playwright';
import {
  createContext,
  humanDelay,
  launchBrowser,
  saveAuthState,
  scrollToBottom,
} from '../utils/browser';
import { Lead, ScraperConfig, ScrapeResult } from '../types';

// ── Login ──────────────────────────────────────────────────────────────────────
async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await humanDelay();

  // Dismiss cookie consent if present
  try {
    await page.locator('[data-cookiebanner="accept_button"], [title="Accept All"]').click({ timeout: 5000 });
    await humanDelay();
  } catch { /* no cookie banner */ }

  await page.fill('#email', email);
  await humanDelay(300, 700);
  await page.fill('#pass', password);
  await humanDelay(300, 700);
  await page.click('[name="login"]');
  await page.waitForURL(/facebook\.com/, { timeout: 15000 });
  await humanDelay(2000, 3000);
}

// ── Expand all comments ────────────────────────────────────────────────────────
async function expandComments(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const viewMore = page.locator(
      'div[role="button"]:has-text("View more comments"), ' +
      'div[role="button"]:has-text("View previous comments"), ' +
      'div[role="button"]:has-text("View more replies")'
    );
    const count = await viewMore.count();
    if (count === 0) break;
    for (let i = 0; i < count; i++) {
      try {
        await viewMore.nth(i).click();
        await humanDelay(1000, 2000);
      } catch { /* stale element */ }
    }
  }
}

// ── Extract comments ───────────────────────────────────────────────────────────
async function extractComments(
  page: Page,
  postUrl: string,
  maxLeads: number
): Promise<Lead[]> {
  await expandComments(page);
  await scrollToBottom(page, 30);
  await expandComments(page);

  const leads: Lead[] = await page.evaluate((args) => {
    const { postUrl, maxLeads } = args;
    const results: Lead[] = [];
    const seen = new Set<string>();

    // Facebook renders comments inside role="article" elements
    const articles = document.querySelectorAll('[role="article"]');
    articles.forEach((article) => {
      if (maxLeads > 0 && results.length >= maxLeads) return;

      const linkEl = article.querySelector<HTMLAnchorElement>(
        'a[href*="facebook.com"], a[href^="/"]'
      );
      if (!linkEl) return;

      const href = linkEl.href?.split('?')[0] ?? '';
      // Skip non-profile links
      if (
        !href ||
        href.includes('/posts/') ||
        href.includes('/photos/') ||
        href.includes('/videos/') ||
        seen.has(href)
      ) return;

      const name = linkEl.textContent?.trim() ?? '';
      if (!name || name.length < 2) return;

      seen.add(href);

      const commentTextEl = article.querySelector(
        '[data-ad-comet-preview="message"], [dir="auto"] > div'
      );
      const commentText = commentTextEl?.textContent?.trim() ?? '';

      results.push({
        name,
        profileUrl: href,
        engagementType: 'commenter',
        commentText: commentText.slice(0, 500),
        platform: 'facebook',
        scrapedAt: new Date().toISOString(),
        sourcePostUrl: postUrl,
      });
    });

    return results;
  }, { postUrl, maxLeads });

  return leads;
}

// ── Extract reactors ───────────────────────────────────────────────────────────
async function extractReactors(
  page: Page,
  postUrl: string,
  maxLeads: number
): Promise<Lead[]> {
  const leads: Lead[] = [];
  const seen = new Set<string>();

  try {
    // Click the reaction count link
    const reactionCountEl = page.locator(
      'span[class*="x16hj40l"], ' +
      'span[aria-label*="reaction"], ' +
      'div[role="button"][aria-label*="reaction"]'
    ).first();

    if (await reactionCountEl.count() === 0) return leads;
    await reactionCountEl.click();
    await humanDelay(2000, 3000);

    // Scroll through the reactors dialog
    const dialog = page.locator('[role="dialog"]').last();
    for (let i = 0; i < 30; i++) {
      if (maxLeads > 0 && leads.length >= maxLeads) break;

      await dialog.evaluate((el) => el.scrollBy(0, el.clientHeight));
      await humanDelay(800, 1500);

      const profileLinks = await dialog.locator('a[href*="facebook.com/"]').all();
      for (const link of profileLinks) {
        const href = ((await link.getAttribute('href')) ?? '').split('?')[0];
        const name = (await link.textContent())?.trim() ?? '';

        if (!name || !href || seen.has(href)) continue;
        if (
          href.includes('/posts/') ||
          href.includes('/photos/') ||
          href.includes('/videos/')
        ) continue;

        seen.add(href);
        leads.push({
          name,
          profileUrl: href,
          engagementType: 'reactor',
          platform: 'facebook',
          scrapedAt: new Date().toISOString(),
          sourcePostUrl: postUrl,
        });

        if (maxLeads > 0 && leads.length >= maxLeads) break;
      }
    }

    await page.keyboard.press('Escape');
    await humanDelay();
  } catch (err) {
    // Reactors modal unavailable
  }

  return leads;
}

// ── Main scrape function ───────────────────────────────────────────────────────
export async function scrapeFacebook(
  postUrl: string,
  config: ScraperConfig
): Promise<ScrapeResult> {
  const result: ScrapeResult = {
    platform: 'facebook',
    postUrl,
    leads: [],
    scrapedAt: new Date().toISOString(),
    errors: [],
  };

  const browser = await launchBrowser(config.headless);
  const context = await createContext(browser, 'facebook');
  const page = await context.newPage();

  try {
    const creds = config.credentials.facebook;
    if (!creds) throw new Error('Facebook credentials not provided.');

    // Check if already logged in
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    const isLoggedIn =
      (await page.locator('[aria-label="Facebook"]').count()) > 0 &&
      !(await page.locator('#email').count() > 0);

    if (!isLoggedIn) {
      await login(page, creds.email, creds.password);
      await saveAuthState(context, 'facebook');
    }

    // Navigate to post
    await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(2000, 3500);

    // Post author
    try {
      const authorLink = page
        .locator('h2 a[href*="facebook.com"], h3 a[href*="facebook.com"]')
        .first();
      const authorName = (await authorLink.textContent())?.trim();
      const authorHref = ((await authorLink.getAttribute('href')) ?? '').split('?')[0];

      if (authorName && authorHref) {
        result.postAuthor = {
          name: authorName,
          profileUrl: authorHref,
          engagementType: 'post_author',
          platform: 'facebook',
          scrapedAt: result.scrapedAt,
          sourcePostUrl: postUrl,
        };
        result.leads.push(result.postAuthor);
      }
    } catch (e) {
      result.errors.push(`Could not extract post author: ${e}`);
    }

    // Comments
    const commenters = await extractComments(page, postUrl, config.maxLeads);
    result.leads.push(...commenters);

    // Reactors
    if (config.maxLeads === 0 || result.leads.length < config.maxLeads) {
      const reactors = await extractReactors(page, postUrl, config.maxLeads);
      const existingUrls = new Set(result.leads.map((l) => l.profileUrl));
      result.leads.push(...reactors.filter((r) => !existingUrls.has(r.profileUrl)));
    }
  } catch (err: any) {
    result.errors.push(err?.message ?? String(err));
  } finally {
    await browser.close();
  }

  return result;
}
