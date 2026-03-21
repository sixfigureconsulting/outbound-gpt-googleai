import { google, sheets_v4 } from 'googleapis';
import { Lead, ScrapeResult } from '../types';

const SHEET_HEADERS = [
  'Name',
  'Profile URL',
  'Engagement Type',
  'Platform',
  'Headline / Bio',
  'Location',
  'Follower Count',
  'Connection Degree',
  'Comment Text',
  'Source Post URL',
  'Scraped At',
];

function buildAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !key) {
    throw new Error(
      'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY in .env'
    );
  }

  return new google.auth.JWT(email, undefined, key, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
}

function leadToRow(lead: Lead): string[] {
  return [
    lead.name,
    lead.profileUrl,
    lead.engagementType,
    lead.platform,
    lead.headline ?? '',
    lead.location ?? '',
    lead.followerCount ?? '',
    lead.connectionDegree ?? '',
    lead.commentText ?? '',
    lead.sourcePostUrl,
    lead.scrapedAt,
  ];
}

async function getOrCreateSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.find(
    (s) => s.properties?.title === sheetName
  );

  if (existing) return existing.properties?.sheetId ?? 0;

  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });
  return (
    addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0
  );
}

async function ensureHeaders(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<void> {
  const firstRow = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:K1`,
  });

  if (!firstRow.data.values || firstRow.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
}

export async function pushToSheets(result: ScrapeResult): Promise<string> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Missing GOOGLE_SPREADSHEET_ID in .env');

  const auth = buildAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Sheet tab named by platform + date
  const today = new Date().toISOString().slice(0, 10);
  const sheetName = `${result.platform}_${today}`;

  await getOrCreateSheet(sheets, spreadsheetId, sheetName);
  await ensureHeaders(sheets, spreadsheetId, sheetName);

  if (result.leads.length === 0) return sheetName;

  const rows = result.leads.map(leadToRow);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });

  return sheetName;
}

export async function pushToNamedSheet(
  result: ScrapeResult,
  sheetName: string
): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Missing GOOGLE_SPREADSHEET_ID in .env');

  const auth = buildAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await getOrCreateSheet(sheets, spreadsheetId, sheetName);
  await ensureHeaders(sheets, spreadsheetId, sheetName);

  if (result.leads.length === 0) return;

  const rows = result.leads.map(leadToRow);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}
