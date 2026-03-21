import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { createObjectCsvWriter } from 'csv-writer';

import { detectPlatform } from './utils/detect';
import { scrapeLinkedIn } from './scrapers/linkedin';
import { scrapeFacebook } from './scrapers/facebook';
import { scrapeInstagram } from './scrapers/instagram';
import { pushToSheets, pushToNamedSheet } from './sheets/index';
import { jobManager } from './jobManager';
import { ScraperConfig, ScrapeResult, Lead } from './types';

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'scraper-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req.session as any).authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Auth routes ────────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!(req.session as any).authenticated });
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    (req.session as any).authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Settings status ────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, (_req, res) => {
  res.json({
    linkedin: !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD),
    facebook: !!(process.env.FACEBOOK_EMAIL && process.env.FACEBOOK_PASSWORD),
    instagram: !!(process.env.INSTAGRAM_USERNAME && process.env.INSTAGRAM_PASSWORD),
    sheets: !!(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_PRIVATE_KEY &&
      process.env.GOOGLE_SPREADSHEET_ID
    ),
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || null,
  });
});

// ── Start a scrape job ─────────────────────────────────────────────────────────
app.post('/api/scrape', requireAuth, (req, res) => {
  const { url, sheetName, noSheets, maxLeads } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  let platform: string;
  try {
    platform = detectPlatform(url);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const job = jobManager.create(url, { sheetName, noSheets: noSheets ?? false });
  jobManager.update(job.id, { platform, status: 'running' });

  runScraper(job.id, url, platform, {
    sheetName,
    noSheets: noSheets ?? false,
    maxLeads: maxLeads ? parseInt(maxLeads, 10) : undefined,
  }).catch(() => {});

  res.json({ jobId: job.id });
});

// ── Jobs list ──────────────────────────────────────────────────────────────────
app.get('/api/jobs', requireAuth, (_req, res) => {
  const jobs = jobManager.getAll().map((j) => ({
    id: j.id,
    url: j.url,
    platform: j.platform,
    status: j.status,
    leadCount: j.leadCount,
    error: j.error,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
  }));
  res.json(jobs);
});

// ── Single job ─────────────────────────────────────────────────────────────────
app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobManager.get(req.params.id as string);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── SSE stream for job progress ────────────────────────────────────────────────
app.get('/api/jobs/:id/stream', requireAuth, (req, res) => {
  const job = jobManager.get(req.params.id as string);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'init', job });

  const onLog = (message: string) => send({ type: 'log', message });
  const onUpdate = (updated: object) => {
    send({ type: 'update', job: updated });
    const status = (updated as any).status;
    if (status === 'done' || status === 'error') cleanup();
  };

  const cleanup = () => {
    jobManager.off(`log:${job.id}`, onLog);
    jobManager.off(`update:${job.id}`, onUpdate);
    res.end();
  };

  jobManager.on(`log:${job.id}`, onLog);
  jobManager.on(`update:${job.id}`, onUpdate);
  req.on('close', cleanup);
});

// ── Download CSV for a job ─────────────────────────────────────────────────────
app.get('/api/jobs/:id/csv', requireAuth, (req, res) => {
  const job = jobManager.get(req.params.id as string);
  if (!job || !job.result) return res.status(404).json({ error: 'No results available' });

  const csv = buildCsvString(job.result.leads);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="leads_${job.platform}_${job.id.slice(0, 8)}.csv"`
  );
  res.send(csv);
});

// ── Catch-all: serve index.html for SPA ───────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Scraper runner ─────────────────────────────────────────────────────────────
async function runScraper(
  jobId: string,
  url: string,
  platform: string,
  opts: { sheetName?: string; noSheets: boolean; maxLeads?: number }
) {
  const config: ScraperConfig = {
    headless: process.env.HEADLESS !== 'false',
    maxLeads: opts.maxLeads ?? parseInt(process.env.MAX_LEADS ?? '0', 10),
    credentials: {
      linkedin:
        process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD
          ? { email: process.env.LINKEDIN_EMAIL, password: process.env.LINKEDIN_PASSWORD }
          : undefined,
      facebook:
        process.env.FACEBOOK_EMAIL && process.env.FACEBOOK_PASSWORD
          ? { email: process.env.FACEBOOK_EMAIL, password: process.env.FACEBOOK_PASSWORD }
          : undefined,
      instagram:
        process.env.INSTAGRAM_USERNAME && process.env.INSTAGRAM_PASSWORD
          ? { username: process.env.INSTAGRAM_USERNAME, password: process.env.INSTAGRAM_PASSWORD }
          : undefined,
    },
  };

  jobManager.log(jobId, `Starting ${platform} scraper...`);

  try {
    let result: ScrapeResult;
    switch (platform) {
      case 'linkedin':
        result = await scrapeLinkedIn(url, config);
        break;
      case 'facebook':
        result = await scrapeFacebook(url, config);
        break;
      case 'instagram':
        result = await scrapeInstagram(url, config);
        break;
      default:
        throw new Error(`Unknown platform: ${platform}`);
    }

    jobManager.log(jobId, `Scraped ${result.leads.length} leads`);

    if (!opts.noSheets) {
      jobManager.log(jobId, 'Pushing to Google Sheets...');
      try {
        const tabName = opts.sheetName
          ? (await pushToNamedSheet(result, opts.sheetName), opts.sheetName)
          : await pushToSheets(result);
        jobManager.log(jobId, `Saved to sheet tab: "${tabName}"`);
      } catch (e: any) {
        jobManager.log(jobId, `Sheets warning: ${e.message}`);
      }
    }

    // Save local CSV
    const outDir = './output';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvPath = `${outDir}/leads_${platform}_${timestamp}.csv`;
    const writer = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: 'name', title: 'Name' },
        { id: 'profileUrl', title: 'Profile URL' },
        { id: 'engagementType', title: 'Engagement Type' },
        { id: 'platform', title: 'Platform' },
        { id: 'headline', title: 'Headline / Bio' },
        { id: 'location', title: 'Location' },
        { id: 'followerCount', title: 'Follower Count' },
        { id: 'connectionDegree', title: 'Connection Degree' },
        { id: 'commentText', title: 'Comment Text' },
        { id: 'sourcePostUrl', title: 'Source Post URL' },
        { id: 'scrapedAt', title: 'Scraped At' },
      ],
    });
    await writer.writeRecords(result.leads);
    jobManager.log(jobId, `CSV saved → ${csvPath}`);

    jobManager.update(jobId, {
      status: 'done',
      result,
      leadCount: result.leads.length,
      completedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    jobManager.log(jobId, `Error: ${err.message}`);
    jobManager.update(jobId, {
      status: 'error',
      error: err.message,
      completedAt: new Date().toISOString(),
    });
  }
}

function buildCsvString(leads: Lead[]): string {
  const headers = [
    'Name', 'Profile URL', 'Engagement Type', 'Platform',
    'Headline / Bio', 'Location', 'Follower Count', 'Connection Degree',
    'Comment Text', 'Source Post URL', 'Scraped At',
  ];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = leads.map((l) =>
    [
      l.name, l.profileUrl, l.engagementType, l.platform,
      l.headline || '', l.location || '', l.followerCount || '',
      l.connectionDegree || '', l.commentText || '', l.sourcePostUrl, l.scrapedAt,
    ].map((v) => escape(String(v))).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

app.listen(PORT, () => {
  console.log(`\n  Social Lead Scraper — Web UI`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
