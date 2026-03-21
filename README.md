# Social Lead Scraper

Scrape all leads (commenters, reactors, post author) from **LinkedIn**, **Facebook**, and **Instagram** posts and push them to a **Google Sheet** — automatically.

## Features

| Platform   | Commenters | Reactors / Likers | Post Author |
|------------|-----------|-------------------|-------------|
| LinkedIn   | ✅        | ✅                | ✅          |
| Facebook   | ✅        | ✅                | ✅          |
| Instagram  | ✅        | ✅ (likes modal)  | ✅          |

- Auto-detects platform from URL
- Saves auth sessions (no re-login needed after first run)
- Exports to **Google Sheets** + local **CSV**
- Bulk scrape from a list of URLs
- Configurable headless mode (set `HEADLESS=false` to watch the browser)

---

## Setup

### 1. Install dependencies

```bash
npm install
npm run install-browsers   # installs Chromium
```

### 2. Configure `.env`

```bash
cp .env.example .env
# fill in your credentials
```

#### Required fields:
| Variable | Description |
|---|---|
| `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` | Your LinkedIn account |
| `FACEBOOK_EMAIL` / `FACEBOOK_PASSWORD` | Your Facebook account |
| `INSTAGRAM_USERNAME` / `INSTAGRAM_PASSWORD` | Your Instagram account |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email from Google Cloud |
| `GOOGLE_PRIVATE_KEY` | Private key from service account JSON |
| `GOOGLE_SPREADSHEET_ID` | ID from your sheet URL |

#### Google Sheets setup:
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → enable **Google Sheets API**
3. Create a **Service Account** → download JSON key
4. Copy `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
5. Copy `private_key` → `GOOGLE_PRIVATE_KEY`
6. **Share** your Google Sheet with the service account email (Editor access)
7. Copy the sheet ID from the URL → `GOOGLE_SPREADSHEET_ID`

---

## Usage

### Build

```bash
npm run build
```

### Scrape a single post

```bash
# LinkedIn
npx ts-node src/index.ts scrape "https://www.linkedin.com/posts/johndoe_activity-123456"

# Facebook
npx ts-node src/index.ts scrape "https://www.facebook.com/johndoe/posts/123456"

# Instagram
npx ts-node src/index.ts scrape "https://www.instagram.com/p/ABC123/"
```

### Push to a custom sheet tab name

```bash
npx ts-node src/index.ts scrape "<url>" --sheet "Campaign March 2026"
```

### Skip Sheets upload (CSV only)

```bash
npx ts-node src/index.ts scrape "<url>" --no-sheets
```

### Show the browser window (useful for debugging / CAPTCHAs)

```bash
HEADLESS=false npx ts-node src/index.ts scrape "<url>"
```

### Bulk scrape from a file

```bash
# urls.txt — one URL per line, # for comments
npx ts-node src/index.ts bulk urls.txt --sheet "Bulk Leads"
```

---

## Output

### Google Sheet columns

| Name | Profile URL | Engagement Type | Platform | Headline / Bio | Location | Follower Count | Connection Degree | Comment Text | Source Post URL | Scraped At |

- A new tab is created per platform per day (e.g. `linkedin_2026-03-21`)
- Or specify `--sheet <name>` to use a custom tab

### CSV

Saved to `./output/leads_<platform>_<timestamp>.csv`

---

## Auth Sessions

After the first successful login, auth cookies are saved to `.auth/<platform>.json`.
Subsequent runs skip the login step automatically.

To force re-login, delete the relevant file:

```bash
rm .auth/linkedin.json
```

---

## Notes

- **Rate limits**: Add delays between requests to avoid account flags. The tool already includes randomized human-like delays.
- **CAPTCHAs**: Set `HEADLESS=false` to manually solve CAPTCHAs during the first login.
- **Private posts**: Only publicly visible posts or posts visible to your account can be scraped.
- **ToS**: Use responsibly and in compliance with each platform's Terms of Service.
