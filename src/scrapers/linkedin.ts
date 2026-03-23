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
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await humanDelay();
  await page.fill('#username', email);
  await humanDelay(300, 700);
  await page.fill('#password', password);
  await humanDelay(300, 700);
  await page.click('[data-litms-control-urn="login-submit"]');
  await page.waitForURL(/feed|checkpoint/, { timeout: 15000 });
}

// ── Expand all "Load more comments" ───────────────────────────────────────────
async function expandComments(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const loadMore = page.locator(
      'button.comments-comments-list__load-more-comments-button, ' +
      'button[aria-label*="Load more comments"], ' +
      'button[aria-label*="more comments"], ' +
      'button.comments-comments-list__show-previous-button, ' +
      'button[aria-label*="previous comments"]'
    );
    const count = await loadMore.count();
    if (count === 0) break;
    for (let i = 0; i < count; i++) {
      try {
        await loadMore.nth(i).click();
        await humanDelay(800, 1500);
      } catch { /* element may have gone stale */ }
    }
    await humanDelay(500, 1000);
  }
}

// ── Extract comments ───────────────────────────────────────────────────────────
async function extractComments(
  page: Page,
  postUrl: string,
  maxLeads: number
): Promise<Lead[]> {
  await expandComments(page);
  await scrollToBottom(page, 40);
  await expandComments(page);

  const leads: Lead[] = await page.evaluate((args) => {
    const { postUrl, maxLeads } = args;
    const results: Lead[] = [];
    const seen = new Set<string>();

    // Try multiple selectors in order — LinkedIn changes class names frequently
    const COMMENT_SELECTORS = [
      '.comments-comment-item',
      '.comments-comment-entity',
      '.comments-comments-list__comment-item',
      '.comments-comment-social-activity',
      '.comments-comments-list article',
      'article[data-id]',
    ];

    let commentItems: NodeListOf<Element> | Element[] = [];
    for (const sel of COMMENT_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { commentItems = found; break; }
    }

    (commentItems as Iterable<Element>)[Symbol.iterator] && Array.from(commentItems as Iterable<Element>).forEach((item) => {
      if (maxLeads > 0 && results.length >= maxLeads) return;

      // Name — try several class combos
      const nameEl =
        item.querySelector('.comments-post-meta__name-text span') ??
        item.querySelector('.comments-post-meta__actor-link span') ??
        item.querySelector('.comments-comment-item__commenter-name-text') ??
        item.querySelector('span.comments-comment-meta__description-title') ??
        item.querySelector('.comments-comment-meta__name') ??
        item.querySelector('.update-components-actor__title span[aria-hidden="true"]') ??
        item.querySelector('span[aria-hidden="true"]');

      // Profile link — attribute-based is most stable
      const linkEl = item.querySelector<HTMLAnchorElement>(
        'a.comments-post-meta__actor-link, ' +
        'a[href*="/in/"], a[href*="/company/"]'
      );

      // Headline / job title
      const headlineEl =
        item.querySelector('.comments-comment-meta__description-subtitle') ??
        item.querySelector('.comments-post-meta__headline') ??
        item.querySelector('.feed-shared-actor__description');

      // Comment text
      const commentTextEl =
        item.querySelector('.comments-comment-item-content-body') ??
        item.querySelector('.comments-comment-item__main-content') ??
        item.querySelector('.feed-shared-update-v2__commentary') ??
        item.querySelector('span[dir="ltr"]');

      const name = nameEl?.textContent?.trim() ?? '';
      const profileUrl = linkEl?.href?.split('?')[0] ?? '';
      const commentText = commentTextEl?.textContent?.trim() ?? '';

      if (!name || !profileUrl || seen.has(profileUrl)) return;
      seen.add(profileUrl);

      results.push({
        name,
        profileUrl,
        headline: headlineEl?.textContent?.trim(),
        engagementType: 'commenter',
        commentText: commentText.slice(0, 500),
        platform: 'linkedin',
        scrapedAt: new Date().toISOString(),
        sourcePostUrl: postUrl,
      });
    });

    return results;
  }, { postUrl, maxLeads });

  return leads;
}

// ── Extract reactors (reactions modal) ────────────────────────────────────────
async function extractReactors(
  page: Page,
  postUrl: string,
  maxLeads: number
): Promise<Lead[]> {
  const leads: Lead[] = [];
  const seen = new Set<string>();

  try {
    // Click the reaction count button to open the reactions modal
    const reactionBtn = page.locator(
      'button[aria-label*="reaction"], ' +
      'button[aria-label*="like"], ' +
      'button.social-details-social-counts__count-value, ' +
      '.social-details-social-counts__reactions button, ' +
      'button.social-details-social-activity'
    ).first();

    if (await reactionBtn.count() === 0) return leads;
    await reactionBtn.click();
    await humanDelay(1500, 2500);

    // Scroll the modal to load all reactors
    const modal = page.locator(
      '.artdeco-modal__content, ' +
      '.social-details-reactors-modal, ' +
      '[aria-label*="reactions"] .artdeco-modal__content, ' +
      '.scaffold-finite-scroll__content'
    ).first();
    for (let i = 0; i < 30; i++) {
      if (maxLeads > 0 && leads.length >= maxLeads) break;
      await modal.evaluate((el) => el.scrollBy(0, el.clientHeight));
      await humanDelay(600, 1200);

      const items = await modal.locator(
        'li.social-details-reactors-tab-body-list-item, ' +
        '.artdeco-list__item, ' +
        'li[class*="reactor"]'
      ).all();
      for (const item of items) {
        const nameEl = await item.locator(
          '.artdeco-entity-lockup__title, ' +
          '.artdeco-entity-lockup__title span[aria-hidden="true"]'
        ).first();
        const linkEl = await item.locator('a[href*="/in/"], a[href*="/company/"]').first();
        const headlineEl = await item.locator(
          '.artdeco-entity-lockup__subtitle, ' +
          '.artdeco-entity-lockup__caption'
        ).first();

        const name = (await nameEl.textContent())?.trim() ?? '';
        const profileUrl = ((await linkEl.getAttribute('href')) ?? '').split('?')[0];

        if (!name || !profileUrl || seen.has(profileUrl)) continue;
        seen.add(profileUrl);

        leads.push({
          name,
          profileUrl,
          headline: (await headlineEl.textContent())?.trim(),
          engagementType: 'reactor',
          platform: 'linkedin',
          scrapedAt: new Date().toISOString(),
          sourcePostUrl: postUrl,
        });

        if (maxLeads > 0 && leads.length >= maxLeads) break;
      }
    }

    // Close modal
    await page.keyboard.press('Escape');
    await humanDelay();
  } catch (err) {
    // Reactors modal unavailable – continue without it
  }

  return leads;
}

// ── Main scrape function ───────────────────────────────────────────────────────
export async function scrapeLinkedIn(
  postUrl: string,
  config: ScraperConfig
): Promise<ScrapeResult> {
  const result: ScrapeResult = {
    platform: 'linkedin',
    postUrl,
    leads: [],
    scrapedAt: new Date().toISOString(),
    errors: [],
  };

  const browser = await launchBrowser(config.headless);
  const context = await createContext(browser, 'linkedin');
  const page = await context.newPage();

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const creds = config.credentials.linkedin;
    if (!creds) throw new Error('LinkedIn credentials not provided.');

    await page.goto('https://www.linkedin.com/feed', { waitUntil: 'domcontentloaded' });
    const isLoggedIn = await page.locator('a[href*="/messaging/"]').count() > 0;

    if (!isLoggedIn) {
      await login(page, creds.email, creds.password);
      await saveAuthState(context, 'linkedin');
    }

    // ── Navigate to post ────────────────────────────────────────────────────
    await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(1500, 3000);

    // ── Post author ─────────────────────────────────────────────────────────
    try {
      const authorName = await page
        .locator(
          '.update-components-actor__name span[aria-hidden="true"], ' +
          '.update-components-actor__title span[aria-hidden="true"], ' +
          '.update-components-actor__container .update-components-actor__name'
        )
        .first()
        .textContent();
      const authorHref = await page
        .locator(
          'a.update-components-actor__meta-link, ' +
          'a.update-components-actor__container-link, ' +
          '.update-components-actor__container a[href*="/in/"], ' +
          '.update-components-actor__container a[href*="/company/"]'
        )
        .first()
        .getAttribute('href');
      const authorHeadline = await page
        .locator(
          '.update-components-actor__description, ' +
          '.update-components-actor__sub-description'
        )
        .first()
        .textContent();

      if (authorName && authorHref) {
        result.postAuthor = {
          name: authorName.trim(),
          profileUrl: authorHref.split('?')[0],
          headline: authorHeadline?.trim(),
          engagementType: 'post_author',
          platform: 'linkedin',
          scrapedAt: result.scrapedAt,
          sourcePostUrl: postUrl,
        };
        result.leads.push(result.postAuthor);
      }
    } catch (e) {
      result.errors.push(`Could not extract post author: ${e}`);
    }

    // ── Comments ────────────────────────────────────────────────────────────
    const commenters = await extractComments(page, postUrl, config.maxLeads);
    result.leads.push(...commenters);

    // ── Reactors ────────────────────────────────────────────────────────────
    if (config.maxLeads === 0 || result.leads.length < config.maxLeads) {
      const reactors = await extractReactors(page, postUrl, config.maxLeads);
      // Deduplicate against already-collected leads
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
