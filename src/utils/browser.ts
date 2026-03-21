import { Browser, BrowserContext, chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const AUTH_DIR = path.join(process.cwd(), '.auth');

export async function launchBrowser(headless: boolean): Promise<Browser> {
  return chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

export async function createContext(
  browser: Browser,
  platform: string
): Promise<BrowserContext> {
  const statePath = path.join(AUTH_DIR, `${platform}.json`);
  const storageState = fs.existsSync(statePath) ? statePath : undefined;

  const context = await browser.newContext({
    storageState,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Mask automation fingerprints
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}

export async function saveAuthState(
  context: BrowserContext,
  platform: string
): Promise<void> {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: path.join(AUTH_DIR, `${platform}.json`) });
}

export async function humanDelay(
  min = 800,
  max = 2500
): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min) + min);
  await new Promise((r) => setTimeout(r, ms));
}

export async function scrollToBottom(page: Page, maxScrolls = 30): Promise<void> {
  let prev = 0;
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await humanDelay(600, 1400);
    const current = await page.evaluate(() => document.body.scrollHeight);
    if (current === prev) break;
    prev = current;
  }
}
