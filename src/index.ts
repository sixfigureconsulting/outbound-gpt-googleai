#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { createObjectCsvWriter } from 'csv-writer';

import { detectPlatform } from './utils/detect';
import { scrapeLinkedIn } from './scrapers/linkedin';
import { scrapeFacebook } from './scrapers/facebook';
import { scrapeInstagram } from './scrapers/instagram';
import { pushToSheets, pushToNamedSheet } from './sheets/index';
import { ScraperConfig, ScrapeResult } from './types';

// ── Build config from env ──────────────────────────────────────────────────────
function buildConfig(): ScraperConfig {
  return {
    headless: process.env.HEADLESS !== 'false',
    maxLeads: parseInt(process.env.MAX_LEADS ?? '0', 10),
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
}

// ── Save results locally as CSV ────────────────────────────────────────────────
async function saveCsv(result: ScrapeResult, outDir: string): Promise<string> {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outDir, `leads_${result.platform}_${timestamp}.csv`);

  const writer = createObjectCsvWriter({
    path: filePath,
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
  return filePath;
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name('lead-scraper')
  .description(
    'Scrape leads (commenters & engagers) from LinkedIn, Facebook, or Instagram posts'
  )
  .version('1.0.0');

program
  .command('scrape <url>')
  .description('Scrape a social media post URL and collect all leads')
  .option('-s, --sheet <name>', 'Google Sheet tab name to push results to')
  .option('-o, --output <dir>', 'Directory to save CSV output', './output')
  .option('--no-sheets', 'Skip Google Sheets upload')
  .option('--no-csv', 'Skip local CSV export')
  .option('--headless <bool>', 'Override HEADLESS env var (true/false)')
  .option('--max-leads <n>', 'Override MAX_LEADS env var')
  .action(async (url: string, opts) => {
    const config = buildConfig();
    if (opts.headless !== undefined) config.headless = opts.headless !== 'false';
    if (opts.maxLeads) config.maxLeads = parseInt(opts.maxLeads, 10);

    let platform: string;
    try {
      platform = detectPlatform(url);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    console.log(chalk.bold.cyan(`\n  Social Lead Scraper`));
    console.log(chalk.gray(`  Platform : ${platform}`));
    console.log(chalk.gray(`  Post URL : ${url}`));
    console.log(chalk.gray(`  Max leads: ${config.maxLeads === 0 ? 'unlimited' : config.maxLeads}`));
    console.log(chalk.gray(`  Headless : ${config.headless}\n`));

    const spinner = ora(`Scraping ${platform} post...`).start();

    let result: ScrapeResult;
    try {
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
    } catch (err: any) {
      spinner.fail(chalk.red(`Scrape failed: ${err.message}`));
      process.exit(1);
    }

    spinner.succeed(
      chalk.green(`Scraped ${chalk.bold(result.leads.length)} leads from ${platform}`)
    );

    if (result.errors.length > 0) {
      console.log(chalk.yellow('\n  Warnings:'));
      result.errors.forEach((e) => console.log(chalk.yellow(`    • ${e}`)));
    }

    // ── CSV ──────────────────────────────────────────────────────────────────
    if (opts.csv !== false) {
      const csvSpinner = ora('Saving CSV...').start();
      try {
        const filePath = await saveCsv(result, opts.output);
        csvSpinner.succeed(chalk.green(`CSV saved → ${filePath}`));
      } catch (e: any) {
        csvSpinner.fail(chalk.red(`CSV save failed: ${e.message}`));
      }
    }

    // ── Google Sheets ────────────────────────────────────────────────────────
    if (opts.sheets !== false) {
      const sheetsSpinner = ora('Pushing to Google Sheets...').start();
      try {
        let sheetName: string;
        if (opts.sheet) {
          await pushToNamedSheet(result, opts.sheet);
          sheetName = opts.sheet;
        } else {
          sheetName = await pushToSheets(result);
        }
        sheetsSpinner.succeed(
          chalk.green(`Pushed to Google Sheets → tab: "${sheetName}"`)
        );
        console.log(
          chalk.gray(
            `  Sheet URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`
          )
        );
      } catch (e: any) {
        sheetsSpinner.fail(chalk.yellow(`Google Sheets skipped: ${e.message}`));
      }
    }

    // ── Summary table ────────────────────────────────────────────────────────
    const counts = result.leads.reduce(
      (acc, l) => {
        acc[l.engagementType] = (acc[l.engagementType] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    console.log(chalk.bold('\n  Lead breakdown:'));
    Object.entries(counts).forEach(([type, count]) => {
      console.log(`    ${chalk.cyan(type.padEnd(15))} ${chalk.bold(count)}`);
    });
    console.log(`    ${'TOTAL'.padEnd(15)} ${chalk.bold.green(result.leads.length)}\n`);
  });

// Bulk scrape from a file of URLs
program
  .command('bulk <file>')
  .description('Scrape multiple post URLs listed in a text file (one URL per line)')
  .option('-s, --sheet <name>', 'Google Sheet tab name (all results go to same tab)')
  .option('-o, --output <dir>', 'Directory to save CSV files', './output')
  .action(async (file: string, opts) => {
    if (!fs.existsSync(file)) {
      console.error(chalk.red(`File not found: ${file}`));
      process.exit(1);
    }

    const urls = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    console.log(chalk.bold.cyan(`\n  Bulk scrape — ${urls.length} URLs\n`));

    for (const url of urls) {
      console.log(chalk.gray(`\n  ──── ${url}`));
      const config = buildConfig();

      try {
        const platform = detectPlatform(url);
        const spinner = ora(`Scraping ${platform}...`).start();

        let result: ScrapeResult;
        switch (platform) {
          case 'linkedin': result = await scrapeLinkedIn(url, config); break;
          case 'facebook': result = await scrapeFacebook(url, config); break;
          case 'instagram': result = await scrapeInstagram(url, config); break;
          default: throw new Error(`Unknown platform: ${platform}`);
        }

        spinner.succeed(chalk.green(`${result.leads.length} leads`));

        if (opts.sheet) {
          await pushToNamedSheet(result, opts.sheet);
        } else {
          await pushToSheets(result);
        }
        await saveCsv(result, opts.output);
      } catch (err: any) {
        console.error(chalk.red(`  Failed: ${err.message}`));
      }
    }

    console.log(chalk.bold.green('\n  Bulk scrape complete.\n'));
  });

program.parse(process.argv);
