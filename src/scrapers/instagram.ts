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
async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto('https://www.instagram.com/accounts/login/', {
    waitUntil: 'domcontentloaded',
  });
  await humanDelay(2000, 3000);

  await page.fill('input[name="username"]', username);
  await humanDelay(400, 800);
  await page.fill('input[name="password"]', password);
  await humanDelay(400, 800);
  await page.click('button[type="submit"]');

  await page.waitForURL(/instagram\.com\/(home|reels|explore|$)/, { timeout: 20000 });
  await humanDelay(2000, 3000);

  // Dismiss "Save your login info?" / notifications prompts
  try {
    await page.locator('button:has-text("Not now"), button:has-text("Not Now")').click({ timeout: 5000 });
    await humanDelay(1000, 2000);
  } catch { /* no prompt */ }
  try {
    await page.locator('button:has-text("Not now"), button:has-text("Not Now")').click({ timeout: 5000 });
    await humanDelay(1000, 2000);
  } catch { /* no prompt */ }
}

// ── Load all comments ──────────────────────────────────────────────────────────
async function loadAllComments(page: Page): Promise<void> {
  // Click "View all X comments" if visible
  try {
    await page.locator('span:has-text("View all"), span:has-text("View"), a:has-text("comments")').first().click({ timeout: 5000 });
    await humanDelay(1500, 2500);
  } catch { /* already expanded */ }

  // Load more comment pages
  for (let attempt = 0; attempt < 20; attempt++) {
    const loadMore = page.locator(
      'button:has-text("Load more comments"), ' +
      'svg[aria-label="Load more comments"]'
    );
    if (await loadMore.count() === 0) break;
    try {
      await loadMore.first().click();
      await humanDelay(1200, 2200);
    } catch { break; }
  }

  // Expand nested replies
  const viewReplies = page.locator('span:has-text("View replies"), button:has-text("replies")');
  const replyCount = await viewReplies.count();
  for (let i = 0; i < Math.min(replyCount, 50); i++) {
    try {
      await viewReplies.nth(i).click();
      await humanDelay(600, 1200);
    } catch { /* stale */ }
  }
}

// ── Extract commenters ─────────────────────────────────────────────────────────
async function extractComments(
  page: Page,
  postUrl: string,
  maxLeads: number
): Promise<Lead[]> {
  await loadAllComments(page);
  await scrollToBottom(page, 20);

  const leads: Lead[] = await page.evaluate((args) => {
    const { postUrl, maxLeads } = args;
    const results: Lead[] = [];
    const seen = new Set<string>();

    // Comments live in <ul> under the article
    const commentEls = document.querySelectorAll(
      'ul li, div[role="button"] ~ ul li'
    );

    commentEls.forEach((el) => {
      if (maxLeads > 0 && results.length >= maxLeads) return;

      const linkEl = el.querySelector<HTMLAnchorElement>(
        'a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"])'
      );
      if (!linkEl) return;

      const username = linkEl.href?.replace(/^.*instagram\.com/, '').replace(/\//g, '').split('?')[0] ?? '';
      if (!username || seen.has(username)) return;

      // Heuristic: username-links contain only a handle-like text
      const nameText = linkEl.textContent?.trim() ?? '';
      if (nameText.length > 35 || nameText.includes(' ')) return; // skip nav links

      seen.add(username);

      const commentTextEl = el.querySelector('span[dir="auto"], div[dir="auto"]');
      const commentText = commentTextEl?.textContent?.trim() ?? '';

      results.push({
        name: nameText || username,
        profileUrl: `https://www.instagram.com/${username}/`,
        engagementType: 'commenter',
        commentText: commentText.slice(0, 500),
        platform: 'instagram',
        scrapedAt: new Date().toISOString(),
        sourcePostUrl: postUrl,
      });
    });

    return results;
  }, { postUrl, maxLeads });

  return leads;
}

// ── Extract likers (post likes modal) ─────────────────────────────────────────
async function extractLikers(
  page: Page,
  postUrl: string,
  maxLeads: number
): Promise<Lead[]> {
  const leads: Lead[] = [];
  const seen = new Set<string>();

  try {
    // Click the likes count
    const likesBtn = page.locator(
      'a[href*="/liked_by/"], ' +
      'button:has-text("like"), ' +
      'span:has-text("like")'
    ).first();

    if (await likesBtn.count() === 0) return leads;
    await likesBtn.click();
    await humanDelay(1500, 2500);

    const dialog = page.locator('[role="dialog"]').last();

    for (let i = 0; i < 40; i++) {
      if (maxLeads > 0 && leads.length >= maxLeads) break;

      await dialog.evaluate((el) => el.scrollBy(0, el.clientHeight));
      await humanDelay(700, 1400);

      const rows = await dialog.locator('div[role="button"], li').all();
      for (const row of rows) {
        const linkEl = row.locator('a[href^="/"]').first();
        const href = ((await linkEl.getAttribute('href')) ?? '').split('?')[0];
        const username = href.replace(/\//g, '');
        if (!username || seen.has(username)) continue;

        const nameEl = row.locator('span').first();
        const name = (await nameEl.textContent())?.trim() ?? username;

        seen.add(username);
        leads.push({
          name,
          profileUrl: `https://www.instagram.com/${username}/`,
          engagementType: 'reactor',
          platform: 'instagram',
          scrapedAt: new Date().toISOString(),
          sourcePostUrl: postUrl,
        });

        if (maxLeads > 0 && leads.length >= maxLeads) break;
      }
    }

    await page.keyboard.press('Escape');
    await humanDelay();
  } catch (err) {
    // Likers modal unavailable (private account or not supported)
  }

  return leads;
}

// ── Main scrape function ───────────────────────────────────────────────────────
export async function scrapeInstagram(
  postUrl: string,
  config: ScraperConfig
): Promise<ScrapeResult> {
  const result: ScrapeResult = {
    platform: 'instagram',
    postUrl,
    leads: [],
    scrapedAt: new Date().toISOString(),
    errors: [],
  };

  const browser = await launchBrowser(config.headless);
  const context = await createContext(browser, 'instagram');
  const page = await context.newPage();

  try {
    const creds = config.credentials.instagram;
    if (!creds) throw new Error('Instagram credentials not provided.');

    // Check auth
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    const isLoggedIn = await page.locator('svg[aria-label="Home"]').count() > 0;

    if (!isLoggedIn) {
      await login(page, creds.username, creds.password);
      await saveAuthState(context, 'instagram');
    }

    // Navigate to post
    await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(2000, 3500);

    // Post author
    try {
      const authorLink = page
        .locator('header a[href^="/"][role="link"], article header a')
        .first();
      const authorHref = ((await authorLink.getAttribute('href')) ?? '').split('?')[0];
      const username = authorHref.replace(/\//g, '');

      if (username) {
        result.postAuthor = {
          name: username,
          profileUrl: `https://www.instagram.com/${username}/`,
          engagementType: 'post_author',
          platform: 'instagram',
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

    // Likers
    if (config.maxLeads === 0 || result.leads.length < config.maxLeads) {
      const likers = await extractLikers(page, postUrl, config.maxLeads);
      const existingUrls = new Set(result.leads.map((l) => l.profileUrl));
      result.leads.push(...likers.filter((l) => !existingUrls.has(l.profileUrl)));
    }
  } catch (err: any) {
    result.errors.push(err?.message ?? String(err));
  } finally {
    await browser.close();
  }

  return result;
}
