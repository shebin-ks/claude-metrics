const express = require('express');
const { Octokit } = require('octokit');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const CACHE_DIR = path.join(__dirname, 'github-data-store');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

app.use(express.json());

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function getAvailableUsers() {
  if (!fs.existsSync(CACHE_DIR)) return {};

  const files = fs.readdirSync(CACHE_DIR);
  const users = {};

  files.forEach(file => {
    const [username, ...parts] = file.replace('.json', '').split('-');
    const dataType = parts.join('-');

    if (!users[username]) users[username] = [];
    if (!users[username].includes(dataType)) {
      users[username].push(dataType);
    }
  });

  return users;
}

function loadData(username, dataType) {
  const file = path.join(CACHE_DIR, `${username}-${dataType}.json`);
  if (!fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function saveData(username, dataType, data) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CACHE_DIR, `${username}-${dataType}.json`),
    JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2),
    'utf8'
  );
}

async function getCurrentUser(octokit) {
  const user = await octokit.rest.users.getAuthenticated();
  return user.data;
}

// Collection functions
async function collectUserProfile(octokit, username) {
  console.log(`   👤 Fetching profile for ${username}...`);
  try {
    const user = await octokit.rest.users.getByUsername({ username });
    console.log(`   ✅ Profile: ${user.data.name} (${user.data.followers} followers)`);
    return {
      id: user.data.id,
      login: user.data.login,
      name: user.data.name,
      email: user.data.email,
      bio: user.data.bio,
      company: user.data.company,
      location: user.data.location,
      website: user.data.blog,
      followers: user.data.followers,
      following: user.data.following,
      public_repos: user.data.public_repos,
      created_at: user.data.created_at,
      updated_at: user.data.updated_at,
      avatar_url: user.data.avatar_url,
    };
  } catch (err) {
    console.error(`   ❌ Profile fetch failed: ${err.message}`);
    throw err;
  }
}

async function collectRepositories(octokit, username) {
  console.log(`   📦 Fetching repositories...`);
  const repos = [];
  let page = 1;
  let hasMore = true;

  try {
    while (hasMore) {
      console.log(`      Fetching page ${page}...`);
      const response = await octokit.rest.repos.listForUser({
        username,
        per_page: 100,
        page,
        sort: 'updated',
      });

      repos.push(...response.data.map(repo => ({
        id: repo.id,
        name: repo.name,
        description: repo.description,
        language: repo.language,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        open_issues: repo.open_issues_count,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        pushed_at: repo.pushed_at,
      })));

      hasMore = response.data.length === 100;
      page++;
    }
    console.log(`   ✅ Repositories: ${repos.length} found`);
    return repos;
  } catch (err) {
    console.error(`   ❌ Repositories fetch failed: ${err.message}`);
    throw err;
  }
}

async function collectCommits(octokit, username, repos) {
  console.log(`   📝 Fetching commits from ${repos.length} repositories...`);
  const commits = [];
  let processed = 0;

  for (const repo of repos) {
    try {
      let page = 1;
      let hasMore = true;
      let repoCommits = 0;

      while (hasMore && commits.length < 5000) {
        const response = await octokit.rest.repos.listCommits({
          owner: username,
          repo: repo.name,
          author: username,
          per_page: 100,
          page,
        });

        commits.push(...response.data.map(c => ({
          repo_name: repo.name,
          sha: c.sha?.substring(0, 7),
          message: c.commit?.message || '',
          author_date: c.commit?.author?.date,
          additions: c.stats?.additions || 0,
          deletions: c.stats?.deletions || 0,
          files_changed: c.files?.length || 0,
        })));

        repoCommits += response.data.length;
        hasMore = response.data.length === 100;
        page++;
      }

      processed++;
      if (repoCommits > 0) {
        console.log(`      [${processed}/${repos.length}] ${repo.name}: ${repoCommits} commits`);
      }
    } catch (err) {
      processed++;
      console.log(`      [${processed}/${repos.length}] ${repo.name}: skipped (${err.message})`);
    }
  }

  console.log(`   ✅ Commits: ${commits.length} found`);
  return commits;
}

async function collectPullRequests(octokit, username, repos) {
  console.log(`   🔀 Fetching pull requests...`);
  const prs = [];

  for (const repo of repos) {
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await octokit.rest.pulls.list({
          owner: username,
          repo: repo.name,
          state: 'all',
          creator: username,
          per_page: 100,
          page,
        });

        prs.push(...response.data.map(pr => ({
          repo_name: repo.name,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          merged: pr.merged || false,
          created_at: pr.created_at,
          merged_at: pr.merged_at,
          additions: pr.additions || 0,
          deletions: pr.deletions || 0,
          changed_files: pr.changed_files || 0,
        })));

        hasMore = response.data.length === 100;
        page++;
      }
    } catch (err) {
      // Skip repos with errors
    }
  }

  console.log(`   ✅ PRs: ${prs.length} found`);
  return prs;
}

async function collectIssues(octokit, username, repos) {
  console.log(`   🐛 Fetching issues...`);
  const issues = [];

  for (const repo of repos) {
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await octokit.rest.issues.listForRepo({
          owner: username,
          repo: repo.name,
          state: 'all',
          creator: username,
          per_page: 100,
          page,
        });

        issues.push(...response.data.filter(i => !i.pull_request).map(i => ({
          repo_name: repo.name,
          number: i.number,
          title: i.title,
          state: i.state,
          labels: i.labels?.map(l => l.name) || [],
          created_at: i.created_at,
          closed_at: i.closed_at,
        })));

        hasMore = response.data.length === 100;
        page++;
      }
    } catch (err) {
      // Skip repos with errors
    }
  }

  console.log(`   ✅ Issues: ${issues.length} found`);
  return issues;
}

async function collectCodeReviews(octokit, username, repos) {
  console.log(`   👀 Fetching code reviews...`);
  const reviews = [];

  for (const repo of repos) {
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const prs = await octokit.rest.pulls.list({
          owner: username,
          repo: repo.name,
          state: 'all',
          per_page: 100,
          page,
        });

        for (const pr of prs.data) {
          try {
            const prReviews = await octokit.rest.pulls.listReviews({
              owner: username,
              repo: repo.name,
              pull_number: pr.number,
            });

            prReviews.data
              .filter(r => r.user?.login === username)
              .forEach(review => {
                reviews.push({
                  repo_name: repo.name,
                  pr_number: pr.number,
                  state: review.state,
                  submitted_at: review.submitted_at,
                });
              });
          } catch (err) {
            // Skip if error
          }
        }

        hasMore = prs.data.length === 100;
        page++;
      }
    } catch (err) {
      // Skip if error
    }
  }

  return reviews;
}

async function collectAllData(token) {
  const octokit = new Octokit({ auth: token });

  const currentUser = await getCurrentUser(octokit);
  const username = currentUser.login;

  const profile = await collectUserProfile(octokit, username);
  const repositories = await collectRepositories(octokit, username);
  const commits = await collectCommits(octokit, username, repositories);
  const prs = await collectPullRequests(octokit, username, repositories);
  const issues = await collectIssues(octokit, username, repositories);
  const reviews = await collectCodeReviews(octokit, username, repositories);

  saveData(username, 'profile', profile);
  saveData(username, 'repositories', repositories);
  saveData(username, 'commits', commits);
  saveData(username, 'pull-requests', prs);
  saveData(username, 'issues', issues);
  saveData(username, 'code-reviews', reviews);

  return {
    username,
    profile,
    repositories,
    commits,
    prs,
    issues,
    reviews,
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.get('/', (req, res) => {
  const users = getAvailableUsers();
  const selectedUser = Object.keys(users)[0];

  if (!selectedUser) {
    const hasEnvToken = !!GITHUB_TOKEN;

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>GitHub Raw Data - Team Dashboard</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; }
          body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #f0f4f8, #d9e2ec); margin: 0; padding: 24px; }
          .card { background: rgba(255,255,255,0.88); border-radius: 14px; padding: 40px; text-align: center; max-width: 600px; margin: 40px auto; box-shadow: 0 8px 20px -4px rgba(0,0,0,0.06); }
          h1 { color: #0f172a; margin: 0 0 16px; font-size: 2rem; }
          p { color: #64748b; margin: 0 0 24px; line-height: 1.5; }
          input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; }
          button { width: 100%; padding: 12px; background: #10b981; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 16px; }
          button:hover { background: #059669; }
          button:disabled { background: #94a3b8; cursor: not-allowed; }
          .info { background: #f0fdf4; border-left: 4px solid #10b981; padding: 16px; margin: 16px 0; border-radius: 8px; text-align: left; color: #166534; }
          .info p { margin: 8px 0; color: #166534; }
          .loading { text-align: center; }
          .spinner { display: inline-block; width: 40px; height: 40px; border: 4px solid #e2e8f0; border-top: 4px solid #10b981; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px 0; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          #status { margin-top: 20px; padding: 12px; border-radius: 8px; display: none; }
          code { background: #f1f5f9; padding: 4px 8px; border-radius: 4px; font-family: monospace; }
        </style>
      </head>
      <body>
      <div class="card" id="mainCard">
        <h1>📊 GitHub Raw Data Dashboard</h1>
        <p>No data collected yet.</p>

        ${hasEnvToken ? `
          <div class="info">
            <p><strong>✅ Using Token from .env</strong></p>
            <p>Starting automatic data fetch...</p>
          </div>
          <div class="loading">
            <div class="spinner"></div>
            <p id="status" style="display: block; background: #dbeafe; color: #1e40af; border: 1px solid #93c5fd;">⏳ Fetching your GitHub data... (this may take 1-2 minutes)</p>
          </div>
        ` : `
          <div class="info">
            <p><strong>✅ Enter GitHub Token</strong></p>
            <p>Paste your GitHub token below to fetch all your GitHub data automatically.</p>
          </div>

          <input type="password" id="token" placeholder="GitHub Token (ghp_...)">
          <button onclick="fetchData()">🔄 Fetch GitHub Data Now</button>

          <div id="status"></div>

          <div class="info" style="margin-top: 24px;">
            <p><strong>💡 What happens:</strong></p>
            <p>• Fetches your complete GitHub profile</p>
            <p>• Downloads all repositories, commits, PRs, issues</p>
            <p>• Stores locally for team presentation</p>
            <p>• Takes 1-2 minutes</p>
          </div>
        `}
      </div>

      <script>
      async function fetchData(tokenToUse) {
        const token = tokenToUse || document.getElementById('token')?.value.trim();
        const status = document.getElementById('status');

        if (!token) {
          status.style.display = 'block';
          status.style.background = '#fee2e2';
          status.style.color = '#991b1b';
          status.textContent = '❌ Please enter your GitHub token';
          return;
        }

        status.style.display = 'block';
        status.style.background = '#dbeafe';
        status.style.color = '#1e40af';
        status.textContent = '⏳ Fetching GitHub data... (this may take 1-2 minutes)';

        try {
          console.log('🔄 Fetching GitHub data...');

          const res = await fetch('/api/fetch-latest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });

          const data = await res.json();
          console.log('✅ Response:', data);

          if (res.ok) {
            status.style.background = '#dcfce7';
            status.style.color = '#166534';
            status.innerHTML = \`✅ Data collected!<br>📦 \${data.counts.repositories} repos<br>📝 \${data.counts.commits} commits<br>📊 Loading dashboard...\`;
            setTimeout(() => location.reload(), 1500);
          } else {
            status.style.background = '#fee2e2';
            status.style.color = '#991b1b';
            status.textContent = '❌ Error: ' + (data.error || 'Unknown error');
          }
        } catch (err) {
          console.error('❌ Fetch error:', err);
          status.style.background = '#fee2e2';
          status.style.color = '#991b1b';
          status.textContent = '❌ Error: ' + err.message;
        }
      }

      // Auto-fetch if token in .env
      ${hasEnvToken ? `
      window.addEventListener("load", () => {
        console.log("📌 Auto-fetching from .env token...");
        fetchData();
      });
      ` : `
      document.getElementById('token')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') fetchData();
      });
      `}
      </script>
      </body>
      </html>
    `);
  }

  const userData = users[selectedUser];
  const userStats = {
    profile: null,
    repos_count: 0,
    commits_count: 0,
    prs_count: 0,
    issues_count: 0,
    reviews_count: 0,
  };

  // Load summary stats
  console.log(`Loading data for ${selectedUser}...`);

  if (userData.includes('profile')) {
    const profileData = loadData(selectedUser, 'profile');
    if (profileData?.data) {
      userStats.profile = profileData.data;
      console.log(`  ✅ Profile loaded`);
    }
  }
  if (userData.includes('repositories')) {
    const reposData = loadData(selectedUser, 'repositories');
    if (reposData?.data) {
      userStats.repos_count = reposData.data.length;
      console.log(`  ✅ Repositories: ${userStats.repos_count}`);
    }
  }
  if (userData.includes('commits')) {
    const commitsData = loadData(selectedUser, 'commits');
    if (commitsData?.data) {
      userStats.commits_count = commitsData.data.length;
      console.log(`  ✅ Commits: ${userStats.commits_count}`);
    }
  }
  if (userData.includes('pull-requests')) {
    const prsData = loadData(selectedUser, 'pull-requests');
    if (prsData?.data) {
      userStats.prs_count = prsData.data.length;
      console.log(`  ✅ PRs: ${userStats.prs_count}`);
    }
  }
  if (userData.includes('issues')) {
    const issuesData = loadData(selectedUser, 'issues');
    if (issuesData?.data) {
      userStats.issues_count = issuesData.data.length;
      console.log(`  ✅ Issues: ${userStats.issues_count}`);
    }
  }
  if (userData.includes('code-reviews')) {
    const reviewsData = loadData(selectedUser, 'code-reviews');
    if (reviewsData?.data) {
      userStats.reviews_count = reviewsData.data.length;
      console.log(`  ✅ Reviews: ${userStats.reviews_count}`);
    }
  }

  const profile = userStats.profile;

  // Build data type cards
  const dataTypeCards = userData.map(type => {
    let icon = '📄';
    let label = type;
    let count = 0;

    switch (type) {
      case 'profile':
        icon = '👤';
        label = 'Profile';
        count = 1;
        break;
      case 'repositories':
        icon = '📦';
        label = 'Repositories';
        count = userStats.repos_count;
        break;
      case 'commits':
        icon = '📝';
        label = 'Commits';
        count = userStats.commits_count;
        break;
      case 'pull-requests':
        icon = '🔀';
        label = 'Pull Requests';
        count = userStats.prs_count;
        break;
      case 'issues':
        icon = '🐛';
        label = 'Issues';
        count = userStats.issues_count;
        break;
      case 'code-reviews':
        icon = '👀';
        label = 'Code Reviews';
        count = userStats.reviews_count;
        break;
      case 'activity-events':
        icon = '📊';
        label = 'Activity Events';
        const eventsData = loadData(selectedUser, 'activity-events');
        count = eventsData?.data?.length || 0;
        break;
      case 'follows':
        icon = '👥';
        label = 'Followers/Following';
        const followsData = loadData(selectedUser, 'follows');
        if (followsData?.data) {
          count = (followsData.data.followers?.length || 0) + (followsData.data.following?.length || 0);
        }
        break;
    }

    return `
      <div class="data-card" onclick="viewData('${type}')">
        <div style="font-size: 2rem; margin-bottom: 8px;">${icon}</div>
        <div class="card-label">${label}</div>
        <div class="card-count">${count} records</div>
        <div style="font-size: 0.8rem; color: #cbd5e1; margin-top: 8px;">click to view →</div>
      </div>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>GitHub Raw Data - Team Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #f0f4f8, #d9e2ec); margin: 0; padding: 24px; color: #334155; }
    h1 { color: #0f172a; font-weight: 700; font-size: 1.8rem; margin: 0 0 8px; }
    h2 { color: #1e293b; font-weight: 600; font-size: 1.1rem; margin: 0 0 12px; }
    .subtitle { font-size: 0.82rem; color: #64748b; margin: 0 0 20px; }
    .card { background: rgba(255,255,255,0.88); backdrop-filter: blur(12px); border-radius: 14px; border: 1px solid rgba(255,255,255,0.4); box-shadow: 0 8px 20px -4px rgba(0,0,0,0.06); padding: 24px; margin-bottom: 20px; }
    .header-card { border-top: 4px solid #3b82f6; display: flex; gap: 20px; align-items: center; }
    .avatar { width: 80px; height: 80px; border-radius: 50%; border: 3px solid #3b82f6; }
    .user-info h1 { margin: 0; }
    .user-info p { margin: 4px 0; color: #64748b; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 20px 0; }
    .data-card { background: #f8fafc; padding: 16px; border-radius: 10px; cursor: pointer; text-align: center; transition: all 0.2s; border: 1px solid #e2e8f0; }
    .data-card:hover { background: #ede9fe; border-color: #c4b5fd; transform: translateY(-2px); }
    .card-label { font-weight: 600; color: #1e293b; margin: 8px 0; }
    .card-count { font-size: 1.5rem; font-weight: 700; color: #3b82f6; }
    .scroll { overflow-x: auto; width: 100%; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e2e8f0; }
    th { background: rgba(248,250,252,0.8); color: #64748b; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; }
    tr:hover td { background: rgba(241,245,249,0.6); }
    .mono { font-size: 0.75em; background: #f1f5f9; border: 1px solid #e2e8f0; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.55); z-index: 100; padding: 20px; }
    .modal.show { display: flex; align-items: center; justify-content: center; }
    .modal-content { background: white; border-radius: 14px; max-width: 90%; max-height: 90vh; overflow-y: auto; padding: 24px; }
    .close-btn { position: absolute; top: 20px; right: 20px; background: #ef4444; color: white; border: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 24px; }
    .back-btn { background: #3b82f6; color: white; padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; margin-bottom: 16px; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
  </style>
</head>
<body>

<div class="card header-card" style="border-top: 4px solid #3b82f6;">
  <div style="flex: 1;">
    <img src="${profile?.avatar_url || 'https://via.placeholder.com/80'}" alt="${selectedUser}" class="avatar">
    <div class="user-info">
      <h1>${profile?.name || selectedUser}</h1>
      <p>@${selectedUser}</p>
      <p style="font-size: 0.9rem; color: #94a3b8;">${profile?.bio || ''}</p>
    </div>
  </div>
  <button onclick="openFetchModal()" style="padding: 10px 20px; background: #10b981; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; white-space: nowrap;">🔄 Fetch Latest</button>
</div>

<div class="card" style="border-top: 4px solid #8b5cf6;">
  <h2>📊 Available Raw Data</h2>
  <p class="subtitle">Click each data type to view raw records (no analysis)</p>
  <div class="grid">
    ${dataTypeCards}
  </div>
</div>

<div id="dataModal" class="modal">
  <div class="modal-content">
    <button class="close-btn" onclick="closeModal()">×</button>
    <button class="back-btn" onclick="closeModal()">← Back</button>
    <h2 id="modalTitle"></h2>
    <div id="modalBody"></div>
  </div>
</div>

<div id="fetchModal" class="modal">
  <div class="modal-content" style="max-width: 400px;">
    <button class="close-btn" onclick="closeFetchModal()">×</button>
    <h2 style="margin-top: 0;">🔄 Refresh GitHub Data</h2>
    <p style="color: #64748b; margin: 0 0 16px;">This will download your latest commits, PRs, issues, and code reviews from GitHub.</p>
    <div id="fetchStatus" style="margin: 12px 0; padding: 10px; border-radius: 8px; display: none; font-size: 14px;"></div>
    <button onclick="startFetch()" style="width: 100%; padding: 10px; background: #10b981; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">🔄 Start Refresh</button>
  </div>
</div>

<script>
const selectedUser = '${selectedUser}';

function viewData(dataType) {
  fetch(\`/api/data/\${selectedUser}/\${dataType}\`)
    .then(r => r.json())
    .then(data => {
      const modal = document.getElementById('dataModal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');

      title.textContent = \`📋 Raw \${dataType.toUpperCase()} Data\`;

      if (data.data && Array.isArray(data.data)) {
        const records = data.data;
        let html = \`<p style="color: #64748b; margin: 0 0 16px;"><strong>\${records.length}</strong> records found</p>\`;

        if (records.length > 0) {
          html += '<table><thead><tr>';
          const keys = Object.keys(records[0]).slice(0, 8);
          keys.forEach(k => html += \`<th>\${k}</th>\`);
          html += '</tr></thead><tbody>';

          records.slice(0, 100).forEach(record => {
            html += '<tr>';
            keys.forEach(k => {
              let val = record[k];
              if (typeof val === 'object') val = JSON.stringify(val).substring(0, 50);
              if (typeof val === 'string' && val.length > 50) val = val.substring(0, 50) + '...';
              html += \`<td class="mono">\${val || '—'}</td>\`;
            });
            html += '</tr>';
          });

          html += '</tbody></table>';

          if (records.length > 100) {
            html += \`<p style="color: #94a3b8; margin-top: 16px;">Showing 100 of \${records.length} records. Download full data via API.</p>\`;
          }
        }

        body.innerHTML = html;
        modal.classList.add('show');
      }
    });
}

function closeModal() {
  document.getElementById('dataModal').classList.remove('show');
}

function openFetchModal() {
  document.getElementById('fetchModal').classList.add('show');
  document.getElementById('fetchToken').focus();
}

function closeFetchModal() {
  document.getElementById('fetchModal').classList.remove('show');
  document.getElementById('fetchStatus').style.display = 'none';
  document.getElementById('fetchToken').value = '';
}

async function startFetch() {
  // Use .env token automatically, no manual input needed
  const status = document.getElementById('fetchStatus');
  const btn = event.target;

  status.style.display = 'block';
  status.style.background = '#dbeafe';
  status.style.color = '#1e40af';
  status.style.border = '1px solid #93c5fd';
  status.textContent = '⏳ Refreshing GitHub data... (this may take 1-2 minutes)';
  btn.disabled = true;

  try {
    const res = await fetch('/api/fetch-latest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // Uses .env GITHUB_TOKEN automatically
    });

    const data = await res.json();

    if (res.ok) {
      status.style.background = '#dcfce7';
      status.style.color = '#166534';
      status.style.border = '1px solid #86efac';
      status.innerHTML = \`✅ Data Refreshed!
        <br>📦 Repos: \${data.counts.repositories}
        <br>📝 Commits: \${data.counts.commits}
        <br>🔀 PRs: \${data.counts.pull_requests}
        <br>🐛 Issues: \${data.counts.issues}
        <br>👀 Reviews: \${data.counts.code_reviews}
        <br><br>Refreshing dashboard...\`;

      setTimeout(() => {
        closeFetchModal();
        location.reload();
      }, 2000);
    } else {
      status.style.background = '#fee2e2';
      status.style.color = '#991b1b';
      status.style.border = '1px solid #fecaca';
      status.textContent = '❌ ' + (data.error || 'Error fetching data');
      btn.disabled = false;
    }
  } catch (err) {
    status.style.background = '#fee2e2';
    status.style.color = '#991b1b';
    status.style.border = '1px solid #fecaca';
    status.textContent = '❌ ' + err.message;
    btn.disabled = false;
  }
}

// Allow Enter key to fetch
document.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && document.getElementById('fetchModal').classList.contains('show')) {
    startFetch();
  }
});
</script>

</body>
</html>`;

  res.send(html);
});

app.get('/api/data/:username/:dataType', (req, res) => {
  const { username, dataType } = req.params;
  const data = loadData(username, dataType);

  if (!data) {
    return res.status(404).json({ error: 'Data not found' });
  }

  res.json(data);
});

app.get('/api/available', (req, res) => {
  res.json(getAvailableUsers());
});

app.post('/api/fetch-latest', async (req, res) => {
  try {
    const token = req.body?.token || GITHUB_TOKEN;

    if (!token) {
      return res.status(400).json({ error: 'GitHub token required' });
    }

    console.log('\n🔄 Starting data collection...');
    console.log('⏳ Fetching profile...');

    const result = await collectAllData(token);

    console.log('✅ Data collection complete!');
    console.log(`   Repos: ${result.repositories.length}`);
    console.log(`   Commits: ${result.commits.length}`);
    console.log(`   PRs: ${result.prs.length}`);
    console.log(`   Issues: ${result.issues.length}`);
    console.log(`   Reviews: ${result.reviews.length}\n`);

    res.json({
      success: true,
      message: 'Data collection complete',
      username: result.username,
      counts: {
        repositories: result.repositories.length,
        commits: result.commits.length,
        pull_requests: result.prs.length,
        issues: result.issues.length,
        code_reviews: result.reviews.length,
      },
    });
  } catch (err) {
    console.error('❌ Error during fetch:', err.message);
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to fetch data' });
  }
});

const PORT = process.env.GITHUB_PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n🚀 GitHub Raw Data Dashboard: http://localhost:${PORT}`);

  if (!GITHUB_TOKEN) {
    console.log('⚠️  No GITHUB_TOKEN in .env - please add it\n');
    return;
  }

  console.log('📌 GITHUB_TOKEN found in .env');

  const users = getAvailableUsers();
  const userCount = Object.keys(users).length;

  console.log(`📊 Users with cached data: ${userCount}`);
  if (userCount > 0) {
    console.log(`   ${Object.keys(users).join(', ')}`);
    console.log('   (Using cached data)\n');
    return;
  }

  // Auto-fetch if no data exists
  console.log('\n🔄 Starting auto-fetch from GitHub...\n');
  try {
    const result = await collectAllData(GITHUB_TOKEN);

    console.log('\n✅ Auto-fetch COMPLETE!');
    console.log(`   User: ${result.username}`);
    console.log(`   📦 Repositories: ${result.repositories.length}`);
    console.log(`   📝 Commits: ${result.commits.length}`);
    console.log(`   🔀 Pull Requests: ${result.prs.length}`);
    console.log(`   🐛 Issues: ${result.issues.length}`);
    console.log(`   👀 Code Reviews: ${result.reviews.length}`);
    console.log('\n✅ Data saved! Open browser now: http://localhost:' + PORT + '\n');
  } catch (err) {
    console.error('\n❌ Auto-fetch FAILED');
    console.error('   Error:', err.message);
    console.log('\n📝 Troubleshooting:');
    console.log('   1. Check GITHUB_TOKEN in .env');
    console.log('   2. Verify token is valid (ghp_xxxx)');
    console.log('   3. Try opening browser at http://localhost:' + PORT + '\n');
  }
});
