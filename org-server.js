const express = require('express');
const { Octokit } = require('octokit');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const CACHE_DIR = path.join(__dirname, 'org-data-store');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG_NAME = process.env.GITHUB_ORG || 'your-org';

app.use(express.json());

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function saveData(dataType, data) {
  const dir = path.join(CACHE_DIR, ORG_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, `${dataType}.json`),
    JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2),
    'utf8'
  );
}

function loadData(dataType) {
  const file = path.join(CACHE_DIR, ORG_NAME, `${dataType}.json`);
  if (!fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function getOrgRepos() {
  const data = loadData('repos');
  return data?.data || [];
}

function getOrgCommits() {
  const data = loadData('commits');
  return data?.data || [];
}

function getOrgPRs() {
  const data = loadData('prs');
  return data?.data || [];
}

function getOrgIssues() {
  const data = loadData('issues');
  return data?.data || [];
}

// Format a duration given in hours into a human-readable string
function formatDuration(hours) {
  if (hours === null || hours === undefined || isNaN(hours)) return '—';
  const totalMinutes = hours * 60;
  if (totalMinutes < 60) return `${Math.round(totalMinutes)}m`;
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  const days = hours / 24;
  return `${Math.round(days * 10) / 10}d`;
}

async function fetchOrgRepos(octokit) {
  console.log(`\n📦 Fetching repositories for organization: ${ORG_NAME}...`);
  const repos = [];
  let page = 1;
  let hasMore = true;

  try {
    while (hasMore) {
      const response = await octokit.rest.repos.listForOrg({
        org: ORG_NAME,
        per_page: 100,
        page,
        type: 'all',
      });

      repos.push(...response.data.map(r => ({
        name: r.name,
        url: r.html_url,
        description: r.description,
      })));

      hasMore = response.data.length === 100;
      page++;
    }

    console.log(`✅ Found ${repos.length} repositories\n`);
    return repos;
  } catch (err) {
    console.error(`❌ Error fetching repos:`, err.message);
    return [];
  }
}

async function fetchAllCommits(octokit, repos) {
  console.log(`📝 Fetching commits from ${repos.length} repositories (all branches)...\n`);
  const commits = [];
  const seenCommitShas = new Set();

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    console.log(`[${i + 1}/${repos.length}] ${repo.name}...`);

    try {
      // First, get all branches
      let branches = [];
      let branchPage = 1;
      let hasMoreBranches = true;

      while (hasMoreBranches) {
        const branchResponse = await octokit.rest.repos.listBranches({
          owner: ORG_NAME,
          repo: repo.name,
          per_page: 100,
          page: branchPage,
        });

        branches.push(...branchResponse.data.map(b => b.name));
        hasMoreBranches = branchResponse.data.length === 100;
        branchPage++;
      }

      let repoCommits = 0;

      // Fetch commits from each branch
      for (const branch of branches) {
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          try {
            const response = await octokit.rest.repos.listCommits({
              owner: ORG_NAME,
              repo: repo.name,
              sha: branch,
              per_page: 100,
              page,
            });

            for (const commit of response.data) {
              // Avoid duplicate commits (same SHA might appear in multiple branches)
              if (!seenCommitShas.has(commit.sha)) {
                seenCommitShas.add(commit.sha);

                // Fetch detailed commit info to get stats
                try {
                  const detailResponse = await octokit.rest.repos.getCommit({
                    owner: ORG_NAME,
                    repo: repo.name,
                    ref: commit.sha,
                  });

                  const detail = detailResponse.data;
                  commits.push({
                    repo: repo.name,
                    branch: branch,
                    author: detail.commit?.author?.name || 'Unknown',
                    email: detail.commit?.author?.email || '',
                    message: detail.commit?.message || '',
                    date: detail.commit?.author?.date,
                    timestamp: new Date(detail.commit?.author?.date).getTime(),
                    sha: detail.sha?.substring(0, 7),
                    url: detail.html_url,
                    additions: detail.stats?.additions || 0,
                    deletions: detail.stats?.deletions || 0,
                    filesChanged: detail.files?.length || 0,
                    totalChanges: (detail.stats?.additions || 0) + (detail.stats?.deletions || 0),
                  });
                } catch (detailErr) {
                  // Fallback if detail fetch fails
                  commits.push({
                    repo: repo.name,
                    branch: branch,
                    author: commit.commit?.author?.name || 'Unknown',
                    email: commit.commit?.author?.email || '',
                    message: commit.commit?.message || '',
                    date: commit.commit?.author?.date,
                    timestamp: new Date(commit.commit?.author?.date).getTime(),
                    sha: commit.sha?.substring(0, 7),
                    url: commit.html_url,
                    additions: 0,
                    deletions: 0,
                    filesChanged: 0,
                    totalChanges: 0,
                  });
                }
              }
            }

            repoCommits += response.data.length;
            hasMore = response.data.length === 100;
            page++;
          } catch (err) {
            // Branch might be deleted or inaccessible
            hasMore = false;
          }
        }
      }

      console.log(`   ✅ ${repo.name}: ${repoCommits} commits from ${branches.length} branches`);
    } catch (err) {
      console.log(`   ⚠️  ${repo.name}: ${err.message}`);
    }
  }

  console.log(`\n✅ Found ${commits.length} total unique commits\n`);
  return commits;
}

async function fetchAllPRs(octokit, repos) {
  console.log(`🔄 Fetching pull requests from ${repos.length} repositories...\n`);
  const prs = [];

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];

    try {
      let page = 1;
      let hasMore = true;
      let repoPRs = 0;

      while (hasMore) {
        const response = await octokit.rest.pulls.list({
          owner: ORG_NAME,
          repo: repo.name,
          state: 'all',
          per_page: 100,
          page,
        });

        response.data.forEach(pr => {
          const createdAt = new Date(pr.created_at).getTime();
          const closedAt = pr.closed_at ? new Date(pr.closed_at).getTime() : null;
          const mergedAt = pr.merged_at ? new Date(pr.merged_at).getTime() : null;
          const timeToMerge = mergedAt ? (mergedAt - createdAt) / (1000 * 60 * 60) : null;

          prs.push({
            repo: repo.name,
            number: pr.number,
            title: pr.title,
            author: pr.user?.login || 'Unknown',
            state: pr.state,
            merged: pr.merged === true || (pr.merged_at !== null && pr.merged_at !== undefined),
            additions: pr.additions || 0,
            deletions: pr.deletions || 0,
            filesChanged: pr.changed_files || 0,
            totalChanges: (pr.additions || 0) + (pr.deletions || 0),
            createdAt: pr.created_at,
            timestamp: createdAt,
            mergedAt: pr.merged_at,
            closedAt: pr.closed_at,
            timeToMergeHours: timeToMerge,
            url: pr.html_url,
            reviewComments: pr.review_comments || 0,
          });
        });

        repoPRs += response.data.length;
        hasMore = response.data.length === 100;
        page++;
      }

      if (repoPRs > 0) console.log(`   ✅ ${repo.name}: ${repoPRs} PRs`);
    } catch (err) {
      console.log(`   ⚠️  ${repo.name}: ${err.message}`);
    }
  }

  const mergedCount = prs.filter(p => p.merged === true).length;
  console.log(`\n✅ Found ${prs.length} total pull requests (${mergedCount} merged)\n`);
  return prs;
}

async function fetchAllOrgData(token, org) {
  const octokit = new (require('octokit')).Octokit({ auth: token });

  const repos = await fetchOrgRepos(octokit);
  if (repos.length === 0) {
    console.log('❌ No repositories found in organization\n');
    return { repos: [], commits: [], prs: [] };
  }

  const [commits, prs] = await Promise.all([
    fetchAllCommits(octokit, repos),
    fetchAllPRs(octokit, repos),
  ]);

  saveData('repos', repos);
  saveData('commits', commits);
  saveData('prs', prs);

  console.log('✅ Organization data collection complete!\n');
  return { repos, commits, prs };
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.post('/api/fetch-org', async (req, res) => {
  try {
    const { org, token } = req.body;
    const actualOrg = org || ORG_NAME;
    const actualToken = token || GITHUB_TOKEN;

    if (!actualToken) {
      return res.status(400).json({ error: 'GITHUB_TOKEN required' });
    }

    const result = await fetchAllOrgData(actualToken, actualOrg);

    res.json({
      success: true,
      message: `Fetched ${result.repos.length} repos, ${result.commits.length} commits, ${result.prs.length} PRs`,
      repos: result.repos.length,
      commits: result.commits.length,
      prs: result.prs.length,
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  console.log(`📍 Dashboard request for org: ${ORG_NAME}`);

  const repos = getOrgRepos();
  const commits = getOrgCommits();
  const prs = getOrgPRs();

  console.log(`   Repos: ${repos.length}, Commits: ${commits.length}, PRs: ${prs.length}`);

  if (repos.length === 0 || commits.length === 0) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Organization Commits</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; }
          body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #f0f4f8, #d9e2ec); margin: 0; padding: 24px; }
          .card { background: rgba(255,255,255,0.88); border-radius: 14px; padding: 40px; text-align: center; max-width: 600px; margin: 40px auto; box-shadow: 0 8px 20px -4px rgba(0,0,0,0.06); }
          h1 { color: #0f172a; margin: 0 0 16px; font-size: 2rem; }
          p { color: #64748b; margin: 0 0 24px; }
          button { width: 100%; padding: 12px; background: #10b981; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 16px; }
          button:hover { background: #059669; }
          button:disabled { background: #94a3b8; cursor: not-allowed; }
          input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; }
          #status { margin-top: 20px; padding: 12px; border-radius: 8px; display: none; }
        </style>
      </head>
      <body>
      <div class="card">
        <h1>🏢 ${ORG_NAME}</h1>
        <p>No commit data collected yet.</p>

        <button onclick="fetchOrg()" id="fetchBtn">🔄 Fetch Organization Data (Commits & PRs)</button>

        <div id="status"></div>
      </div>

      <script>
      async function fetchOrg() {
        const btn = document.getElementById('fetchBtn');
        const status = document.getElementById('status');

        btn.disabled = true;
        status.style.display = 'block';
        status.style.background = '#dbeafe';
        status.style.color = '#1e40af';
        status.textContent = '⏳ Fetching all organization repositories, commits, and pull requests... (this may take several minutes)';

        try {
          const res = await fetch('/api/fetch-org', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });

          const data = await res.json();

          if (res.ok) {
            status.style.background = '#dcfce7';
            status.style.color = '#166534';
            status.textContent = \`✅ Fetched \${data.repos} repos, \${data.commits} commits, \${data.prs} PRs! Reloading...\`;
            setTimeout(() => location.reload(), 1500);
          } else {
            status.style.background = '#fee2e2';
            status.style.color = '#991b1b';
            status.textContent = '❌ ' + data.error;
            btn.disabled = false;
          }
        } catch (err) {
          status.style.background = '#fee2e2';
          status.style.color = '#991b1b';
          status.textContent = '❌ ' + err.message;
          btn.disabled = false;
        }
      }
      </script>
      </body>
      </html>
    `);
  }

  // Build performance metrics
  const commitsByAuthor = {};
  commits.forEach(c => {
    if (!commitsByAuthor[c.author]) {
      commitsByAuthor[c.author] = {
        commits: 0,
        repos: new Set(),
        totalAdditions: 0,
        totalDeletions: 0,
        totalChanges: 0,
        filesChanged: 0,
      };
    }
    commitsByAuthor[c.author].commits++;
    commitsByAuthor[c.author].repos.add(c.repo);
    commitsByAuthor[c.author].totalAdditions += c.additions;
    commitsByAuthor[c.author].totalDeletions += c.deletions;
    commitsByAuthor[c.author].totalChanges += c.totalChanges;
    commitsByAuthor[c.author].filesChanged += c.filesChanged;
  });

  const authorsData = Object.entries(commitsByAuthor)
    .map(([author, data]) => ({
      author,
      commits: data.commits,
      repos: data.repos.size,
      additions: data.totalAdditions,
      deletions: data.totalDeletions,
      totalChanges: data.totalChanges,
      filesChanged: data.filesChanged,
      avgChangesPerCommit: Math.round(data.totalChanges / data.commits),
    }))
    .sort((a, b) => b.totalChanges - a.totalChanges);

  const authorRows = authorsData.map(a => `
    <tr>
      <td class="bold">${a.author}</td>
      <td>${a.commits}</td>
      <td>${a.repos}</td>
      <td class="additions">+${a.additions.toLocaleString()}</td>
      <td class="deletions">-${a.deletions.toLocaleString()}</td>
      <td>${a.totalChanges.toLocaleString()}</td>
      <td>${a.filesChanged.toLocaleString()}</td>
      <td>${a.avgChangesPerCommit}</td>
    </tr>
  `).join('');

  // Build PR metrics by author
  const prsByAuthor = {};
  prs.forEach(pr => {
    if (!prsByAuthor[pr.author]) {
      prsByAuthor[pr.author] = {
        totalPRs: 0,
        mergedPRs: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        totalChanges: 0,
        totalTimeToMerge: 0,
        filesChanged: 0,
      };
    }
    prsByAuthor[pr.author].totalPRs++;
    if (pr.merged === true) prsByAuthor[pr.author].mergedPRs++;
    prsByAuthor[pr.author].totalAdditions += pr.additions;
    prsByAuthor[pr.author].totalDeletions += pr.deletions;
    prsByAuthor[pr.author].totalChanges += pr.totalChanges;
    prsByAuthor[pr.author].filesChanged += pr.filesChanged;
    if (pr.timeToMergeHours) prsByAuthor[pr.author].totalTimeToMerge += pr.timeToMergeHours;
  });

  const prAuthorsData = Object.entries(prsByAuthor)
    .map(([author, data]) => ({
      author,
      totalPRs: data.totalPRs,
      mergedPRs: data.mergedPRs,
      mergeRate: data.totalPRs > 0 ? Math.round((data.mergedPRs / data.totalPRs) * 100) : 0,
      additions: data.totalAdditions,
      deletions: data.totalDeletions,
      totalChanges: data.totalChanges,
      filesChanged: data.filesChanged,
      avgTimeToMergeHours: data.mergedPRs > 0 ? data.totalTimeToMerge / data.mergedPRs : null,
    }))
    .sort((a, b) => b.totalPRs - a.totalPRs);

  const prAuthorRows = prAuthorsData.map(a => `
    <tr>
      <td class="bold">${a.author}</td>
      <td>${a.totalPRs}</td>
      <td>${a.mergedPRs}</td>
      <td>${a.mergeRate}%</td>
      <td class="additions">+${a.additions.toLocaleString()}</td>
      <td class="deletions">-${a.deletions.toLocaleString()}</td>
      <td>${a.totalChanges.toLocaleString()}</td>
      <td>${a.filesChanged}</td>
      <td>${formatDuration(a.avgTimeToMergeHours)}</td>
    </tr>
  `).join('');

  const sortedCommits = commits.sort((a, b) => b.timestamp - a.timestamp);

  const commitRows = sortedCommits.slice(0, 100).map(c => {
    const dateObj = new Date(c.date);
    const dateTime = dateObj.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    const branchBadge = c.branch && c.branch !== 'main' ? `<span style="background: #fbbf24; color: #78350f; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">${c.branch}</span>` : '<span style="color: #64748b;">main</span>';
    return `
    <tr>
      <td class="mono">${dateTime}</td>
      <td class="bold">${c.repo}</td>
      <td>${branchBadge}</td>
      <td>${c.author}</td>
      <td class="additions">+${c.additions}</td>
      <td class="deletions">-${c.deletions}</td>
      <td>${c.filesChanged}</td>
      <td title="${c.message}">${c.message.split('\n')[0].substring(0, 40)}</td>
      <td><a href="${c.url}" target="_blank" class="link">${c.sha}</a></td>
    </tr>
  `;
  }).join('');

  const sortedPRs = prs.sort((a, b) => b.timestamp - a.timestamp);

  const prRows = sortedPRs.slice(0, 50).map(pr => {
    const dateObj = new Date(pr.createdAt);
    const dateTime = dateObj.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    const statusBadge = pr.merged ? '<span style="color: #10b981; font-weight: 600;">✅ Merged</span>' : pr.state === 'open' ? '<span style="color: #3b82f6; font-weight: 600;">🔵 Open</span>' : '<span style="color: #ef4444; font-weight: 600;">❌ Closed</span>';
    return `
    <tr>
      <td class="mono">${dateTime}</td>
      <td class="bold">${pr.repo}</td>
      <td>${pr.author}</td>
      <td>${statusBadge}</td>
      <td class="additions">+${pr.additions.toLocaleString()}</td>
      <td class="deletions">-${pr.deletions.toLocaleString()}</td>
      <td>${pr.filesChanged}</td>
      <td>${pr.merged ? formatDuration(pr.timeToMergeHours) : '—'}</td>
      <td title="${pr.title}">${pr.title.substring(0, 35)}</td>
      <td><a href="${pr.url}" target="_blank" class="link">#${pr.number}</a></td>
    </tr>
  `;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Organization Commits - ${ORG_NAME}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #f0f4f8, #d9e2ec); margin: 0; padding: 24px; color: #334155; }
    h1 { color: #0f172a; font-weight: 700; font-size: 1.8rem; margin: 0 0 8px; }
    h2 { color: #1e293b; font-weight: 600; font-size: 1.1rem; margin: 0 0 12px; }
    .subtitle { font-size: 0.82rem; color: #64748b; margin: 0 0 20px; }
    .card { background: rgba(255,255,255,0.88); backdrop-filter: blur(12px); border-radius: 14px; border: 1px solid rgba(255,255,255,0.4); box-shadow: 0 8px 20px -4px rgba(0,0,0,0.06); padding: 24px; margin-bottom: 20px; }
    .header { border-top: 4px solid #3b82f6; display: flex; justify-content: space-between; align-items: center; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 20px 0; }
    .stat-box { background: #f8fafc; padding: 16px; border-radius: 10px; border-left: 4px solid #3b82f6; }
    .stat-label { font-size: 0.75rem; color: #64748b; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; }
    .stat-value { font-size: 1.8rem; font-weight: 700; color: #0f172a; }
    button { padding: 10px 20px; background: #10b981; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; }
    button:hover { background: #059669; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e2e8f0; }
    th { background: rgba(248,250,252,0.8); color: #64748b; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; }
    tr:hover td { background: rgba(241,245,249,0.6); }
    .bold { font-weight: 600; color: #1e293b; }
    .mono { font-size: 0.75em; background: #f1f5f9; border: 1px solid #e2e8f0; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .scroll { overflow-x: auto; width: 100%; }
    .link { color: #3b82f6; text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .additions { color: #10b981; font-weight: 600; }
    .deletions { color: #ef4444; font-weight: 600; }
  </style>
</head>
<body>

<div class="card header">
  <div>
    <h1>🏢 ${ORG_NAME}</h1>
    <p class="subtitle">Organization Repository Commits</p>
  </div>
  <button onclick="startRefresh()" id="refreshBtn">🔄 Refresh</button>
</div>

<div id="loadingOverlay" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.7); z-index: 1000; display: none; align-items: center; justify-content: center;">
  <div style="background: white; border-radius: 14px; padding: 40px; text-align: center; max-width: 400px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);">
    <h2 style="margin: 0 0 20px; color: #0f172a;">⏳ Refreshing Organization Data</h2>
    <div style="margin: 20px 0;">
      <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
        <div id="progressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #3b82f6, #10b981); transition: width 0.3s; border-radius: 4px;"></div>
      </div>
    </div>
    <p id="statusText" style="margin: 20px 0; color: #64748b; font-size: 0.9rem;">Starting fetch...</p>
    <p style="margin: 0; color: #94a3b8; font-size: 0.8rem;">This may take a few minutes</p>
  </div>
</div>

<div class="card">
  <h2>📊 Statistics</h2>
  <div class="stats">
    <div class="stat-box">
      <div class="stat-label">Total Repositories</div>
      <div class="stat-value">${repos.length}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Total Commits</div>
      <div class="stat-value">${commits.length.toLocaleString()}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Total Contributors</div>
      <div class="stat-value">${authorsData.length}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Pull Requests</div>
      <div class="stat-value">${prs.length.toLocaleString()}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Merged PRs</div>
      <div class="stat-value">${prs.filter(p => p.merged === true).length}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Merge Rate</div>
      <div class="stat-value">${prs.length > 0 ? Math.round((prs.filter(p => p.merged === true).length / prs.length) * 100) : 0}%</div>
    </div>
  </div>
</div>

<div class="card">
  <h2>👥 Developer Performance</h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Author</th><th>Commits</th><th>Repos</th><th>Additions</th><th>Deletions</th><th>Total Changes</th><th>Files</th><th>Avg/Commit</th>
      </tr></thead>
      <tbody>${authorRows}</tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>📝 Recent Commits (latest 100, all branches)</h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Date & Time</th><th>Repository</th><th>Branch</th><th>Author</th><th>Additions</th><th>Deletions</th><th>Files</th><th>Message</th><th>Link</th>
      </tr></thead>
      <tbody>${commitRows}</tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>🔄 Pull Request Performance</h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Author</th><th>Total PRs</th><th>Merged</th><th>Merge %</th><th>Additions</th><th>Deletions</th><th>Total Changes</th><th>Files</th><th>Avg Time</th>
      </tr></thead>
      <tbody>${prAuthorRows}</tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>🎯 Recent Pull Requests (latest 50)</h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Date</th><th>Repository</th><th>Author</th><th>Status</th><th>Additions</th><th>Deletions</th><th>Files</th><th>Merge Time</th><th>Title</th><th>Link</th>
      </tr></thead>
      <tbody>${prRows}</tbody>
    </table>
  </div>
</div>

<script>
let fetchProgress = 0;
let pollInterval;

async function startRefresh() {
  const btn = document.getElementById('refreshBtn');
  const overlay = document.getElementById('loadingOverlay');
  const statusText = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');

  btn.disabled = true;
  overlay.style.display = 'flex';
  fetchProgress = 0;
  progressBar.style.width = '0%';
  statusText.textContent = '📦 Fetching repositories...';

  try {
    const res = await fetch('/api/fetch-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const data = await res.json();

    if (res.ok) {
      progressBar.style.width = '100%';
      statusText.innerHTML = \`✅ Complete!<br>📦 \${data.repos} repos<br>📝 \${data.commits} commits<br>🔄 \${data.prs} PRs\`;

      setTimeout(() => {
        overlay.style.display = 'none';
        location.reload();
      }, 1500);
    } else {
      statusText.textContent = '❌ Error: ' + data.error;
      btn.disabled = false;
    }
  } catch (err) {
    statusText.textContent = '❌ Error: ' + err.message;
    btn.disabled = false;
  }
}

// Simulate progress bar animation
setInterval(() => {
  const bar = document.getElementById('progressBar');
  if (bar && bar.parentElement.parentElement.parentElement.style.display !== 'none') {
    let current = parseFloat(bar.style.width) || 0;
    if (current < 90) {
      current += Math.random() * 15;
      bar.style.width = Math.min(current, 90) + '%';
    }
  }
}, 500);
</script>

</body>
</html>`;

  res.send(html);
});

const PORT = process.env.ORG_PORT || 3002;
app.listen(PORT, async () => {
  console.log(`\n🚀 Organization Commits Analytics: http://localhost:${PORT}`);
  console.log(`🏢 Organization: ${ORG_NAME}`);

  if (!GITHUB_TOKEN) {
    console.log('⚠️  No GITHUB_TOKEN in .env\n');
    return;
  }

  const repos = getOrgRepos();
  const commits = getOrgCommits();

  console.log(`📊 Cached: ${repos.length} repos, ${commits.length} commits\n`);

  if (repos.length === 0) {
    console.log('📌 Auto-fetching organization data...\n');
    try {
      await fetchAllOrgData(GITHUB_TOKEN, ORG_NAME);
      console.log('✅ Auto-fetch complete! Open browser now.\n');
    } catch (err) {
      console.error('❌ Auto-fetch failed:', err.message);
      console.log('   Try opening browser and clicking fetch.\n');
    }
  }
});
