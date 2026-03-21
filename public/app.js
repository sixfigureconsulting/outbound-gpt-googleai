/* ── State ── */
let activeJobId = null;
let activeEventSource = null;

/* ── Init ── */
(async function init() {
  const res = await fetch('/api/me');
  const { authenticated } = await res.json();
  if (authenticated) {
    showApp();
  } else {
    document.getElementById('loginPage').style.display = 'flex';
  }
})();

/* ── Auth ── */
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginError');
  const password = document.getElementById('passwordInput').value;

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('loginPage').style.display = 'none';
      showApp();
    } else {
      errEl.textContent = data.error || 'Invalid password';
      errEl.style.display = 'block';
    }
  } catch {
    errEl.textContent = 'Connection error. Please try again.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function handleLogout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

/* ── Show app ── */
function showApp() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  loadSettings();
  loadJobs();
  setInterval(loadJobs, 8000); // auto-refresh jobs list
}

/* ── Settings ── */
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();

    const grid = document.getElementById('settingsGrid');
    const platforms = [
      { key: 'linkedin', label: 'LinkedIn' },
      { key: 'facebook', label: 'Facebook' },
      { key: 'instagram', label: 'Instagram' },
      { key: 'sheets', label: 'Google Sheets' },
    ];

    grid.innerHTML = platforms
      .map(
        (p) => `
      <div class="setting-pill ${data[p.key] ? 'ok' : 'missing'}">
        <span class="dot"></span>
        ${p.label}
      </div>`
      )
      .join('');

    if (data.spreadsheetId) {
      const link = document.getElementById('sheetLink');
      link.href = `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}`;
      link.style.display = 'inline';
    }
  } catch (e) {
    console.error('Settings load failed', e);
  }
}

/* ── Scrape form ── */
async function handleScrape(e) {
  e.preventDefault();
  const btn = document.getElementById('scrapeBtn');
  const errEl = document.getElementById('scrapeError');

  const url = document.getElementById('urlInput').value.trim();
  const sheetName = document.getElementById('sheetInput').value.trim() || undefined;
  const noSheets = document.getElementById('noSheetsCheck').checked;
  const maxLeads = document.getElementById('maxLeadsInput').value || undefined;

  btn.disabled = true;
  btn.textContent = 'Starting…';
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, sheetName, noSheets, maxLeads }),
    });
    const data = await res.json();

    if (res.ok) {
      document.getElementById('urlInput').value = '';
      document.getElementById('sheetInput').value = '';
      document.getElementById('maxLeadsInput').value = '';
      document.getElementById('noSheetsCheck').checked = false;
      await loadJobs();
      openJobDrawer(data.jobId);
    } else {
      errEl.textContent = data.error || 'Failed to start scrape';
      errEl.style.display = 'block';
    }
  } catch {
    errEl.textContent = 'Connection error. Please try again.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Start Scrape';
  }
}

/* ── Jobs list ── */
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const jobs = await res.json();
    renderJobs(jobs);
  } catch (e) {
    console.error('Jobs load failed', e);
  }
}

function renderJobs(jobs) {
  const container = document.getElementById('jobsContainer');

  if (!jobs.length) {
    container.innerHTML = '<div class="jobs-empty">No jobs yet. Start a scrape above.</div>';
    return;
  }

  container.innerHTML = `
    <table class="jobs-table">
      <thead>
        <tr>
          <th>Platform</th>
          <th>URL</th>
          <th>Status</th>
          <th>Leads</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map((j) => jobRow(j)).join('')}
      </tbody>
    </table>`;
}

function jobRow(j) {
  const platform = j.platform || '—';
  const platformHtml = platformChip(platform);
  const statusHtml = statusBadge(j.status);
  const leads = j.leadCount != null ? j.leadCount : j.status === 'error' ? '—' : '…';
  const time = j.createdAt ? timeAgo(j.createdAt) : '—';
  const shortUrl = j.url.length > 50 ? j.url.slice(0, 50) + '…' : j.url;

  return `<tr onclick="openJobDrawer('${j.id}')" title="${escHtml(j.url)}">
    <td>${platformHtml}</td>
    <td style="color:var(--text-muted);font-size:12px">${escHtml(shortUrl)}</td>
    <td>${statusHtml}</td>
    <td style="font-weight:600">${leads}</td>
    <td style="color:var(--text-muted)">${time}</td>
  </tr>`;
}

function platformChip(p) {
  const icons = { linkedin: '&#128100;', facebook: '&#128081;', instagram: '&#128247;' };
  const icon = icons[p] || '&#127760;';
  return `<span class="platform-chip ${p}">${icon} ${p}</span>`;
}

function statusBadge(status) {
  if (status === 'running')
    return `<span class="badge badge-running"><span class="pulse"></span> Running</span>`;
  if (status === 'done') return `<span class="badge badge-done">&#10003; Done</span>`;
  if (status === 'error') return `<span class="badge badge-error">&#10005; Error</span>`;
  return `<span class="badge badge-pending">Pending</span>`;
}

/* ── Drawer ── */
async function openJobDrawer(jobId) {
  activeJobId = jobId;

  // Reset drawer
  document.getElementById('logBox').innerHTML = '';
  document.getElementById('resultsTable').style.display = 'none';
  document.getElementById('resultsBody').innerHTML = '';
  document.getElementById('noResults').style.display = 'none';
  document.getElementById('downloadCsvBtn').style.display = 'none';

  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('drawer').classList.add('open');

  // Load full job
  const res = await fetch(`/api/jobs/${jobId}`);
  const job = await res.json();

  renderDrawerJob(job);

  // If still running, open SSE stream
  if (job.status === 'running' || job.status === 'pending') {
    startStream(jobId);
  }
}

function renderDrawerJob(job) {
  document.getElementById('drawerTitle').textContent =
    `${job.platform || 'Job'} — ${job.status}`;
  document.getElementById('drawerSubtitle').textContent = job.url;

  // Logs
  const logBox = document.getElementById('logBox');
  logBox.innerHTML = job.logs
    .map((l) => `<div class="${logClass(l)}">${escHtml(l)}</div>`)
    .join('');
  logBox.scrollTop = logBox.scrollHeight;

  // Results
  if (job.status === 'done') {
    document.getElementById('downloadCsvBtn').style.display = 'inline-flex';
    if (job.result && job.result.leads && job.result.leads.length > 0) {
      renderResults(job.result.leads);
    } else {
      document.getElementById('noResults').style.display = 'block';
    }
  }

  if (job.status === 'error') {
    const logBox = document.getElementById('logBox');
    if (job.error) {
      logBox.innerHTML += `<div class="log-error">&#10005; ${escHtml(job.error)}</div>`;
    }
  }
}

function renderResults(leads) {
  const tbody = document.getElementById('resultsBody');
  tbody.innerHTML = leads
    .map(
      (l) => `
    <tr>
      <td><a href="${escHtml(l.profileUrl)}" target="_blank">${escHtml(l.name)}</a></td>
      <td><span class="eng-${l.engagementType}">${l.engagementType}</span></td>
      <td title="${escHtml(l.headline || '')}">${escHtml(l.headline || '—')}</td>
      <td>${escHtml(l.location || '—')}</td>
      <td title="${escHtml(l.commentText || '')}">${escHtml((l.commentText || '').slice(0, 60) || '—')}</td>
    </tr>`
    )
    .join('');

  document.getElementById('resultsTable').style.display = 'table';
}

function startStream(jobId) {
  if (activeEventSource) activeEventSource.close();

  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  activeEventSource = es;

  es.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'log') {
      const logBox = document.getElementById('logBox');
      const div = document.createElement('div');
      div.className = logClass(data.message);
      div.textContent = data.message;
      logBox.appendChild(div);
      logBox.scrollTop = logBox.scrollHeight;
    }

    if (data.type === 'update') {
      const job = data.job;
      document.getElementById('drawerTitle').textContent =
        `${job.platform || 'Job'} — ${job.status}`;

      if (job.status === 'done' || job.status === 'error') {
        es.close();
        activeEventSource = null;
        // Reload full job to get results
        fetch(`/api/jobs/${jobId}`)
          .then((r) => r.json())
          .then((j) => {
            renderDrawerJob(j);
            loadJobs();
          });
      }
    }
  };

  es.onerror = () => {
    es.close();
    activeEventSource = null;
  };
}

function closeDrawer() {
  document.getElementById('drawerOverlay').classList.remove('open');
  document.getElementById('drawer').classList.remove('open');
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  activeJobId = null;
}

function downloadCsv() {
  if (!activeJobId) return;
  window.open(`/api/jobs/${activeJobId}/csv`, '_blank');
}

/* ── Helpers ── */
function logClass(msg) {
  const m = msg.toLowerCase();
  if (m.includes('error') || m.includes('failed')) return 'log-error';
  if (m.includes('done') || m.includes('scraped') || m.includes('saved') || m.includes('pushed'))
    return 'log-done';
  return 'log-info';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});
