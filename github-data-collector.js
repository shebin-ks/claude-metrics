/**
 * GitHub Data Collector
 * Comprehensive data collection from GitHub API
 * NO ANALYSIS - Just raw data for future insights
 */

const express = require('express');
const { Octokit } = require('octokit');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const CACHE_DIR = path.join(__dirname, 'github-data-store');
const DATA_FILE = path.join(__dirname, 'data.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

app.use(express.json());

let claudeCodeData = {};

function loadClaudeData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      claudeCodeData = data.userSessions || {};
    } catch (err) {
      console.error('Error reading Claude Code data:', err);
    }
  }
}

function getDataFile(username, dataType) {
  return path.join(CACHE_DIR, `${username}-${dataType}.json`);
}

function saveData(username, dataType, data) {
  fs.writeFileSync(
    getDataFile(username, dataType),
    JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2),
    'utf8'
  );
}

async function getCurrentUser(octokit) {
  const user = await octokit.rest.users.getAuthenticated();
  return user.data;
}

// ============= USER PROFILE DATA =============
async function collectUserProfile(octokit, username) {
  console.log('📋 Collecting user profile...');
  const user = await octokit.rest.users.getByUsername({ username });

  return {
    id: user.data.id,
    login: user.data.login,
    name: user.data.name,
    email: user.data.email,
    bio: user.data.bio,
    company: user.data.company,
    location: user.data.location,
    website: user.data.blog,
    twitter: user.data.twitter_username,
    followers: user.data.followers,
    following: user.data.following,
    public_repos: user.data.public_repos,
    public_gists: user.data.public_gists,
    created_at: user.data.created_at,
    updated_at: user.data.updated_at,
    avatar_url: user.data.avatar_url,
    type: user.data.type,
    hireable: user.data.hireable,
  };
}

// ============= REPOSITORIES DATA =============
async function collectRepositories(octokit, username) {
  console.log('📦 Collecting repositories data...');
  const repos = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await octokit.rest.repos.listForUser({
      username,
      per_page: 100,
      page,
      sort: 'updated',
    });

    for (const repo of response.data) {
      repos.push({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description,
        url: repo.html_url,
        homepage: repo.homepage,
        is_private: repo.private,
        is_fork: repo.fork,
        language: repo.language,
        languages: await collectRepositoryLanguages(octokit, username, repo.name),
        topics: repo.topics,
        stars: repo.stargazers_count,
        watchers: repo.watchers_count,
        forks: repo.forks_count,
        open_issues: repo.open_issues_count,
        size: repo.size,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        pushed_at: repo.pushed_at,
        default_branch: repo.default_branch,
        license: repo.license?.name,
      });
    }

    hasMore = response.data.length === 100;
    page++;
  }

  return repos;
}

async function collectRepositoryLanguages(octokit, username, repoName) {
  try {
    const langs = await octokit.rest.repos.listLanguages({
      owner: username,
      repo: repoName,
    });
    return langs.data;
  } catch (err) {
    return {};
  }
}

// ============= COMMITS DATA =============
async function collectCommits(octokit, username, repos) {
  console.log('📝 Collecting commit history...');
  const commits = [];

  for (const repo of repos) {
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore && commits.length < 5000) {
        const response = await octokit.rest.repos.listCommits({
          owner: username,
          repo: repo.name,
          author: username,
          per_page: 100,
          page,
        });

        response.data.forEach(commit => {
          commits.push({
            repo_name: repo.name,
            repo_id: repo.id,
            sha: commit.sha,
            message: commit.commit?.message || '',
            author_name: commit.commit?.author?.name || '',
            author_email: commit.commit?.author?.email || '',
            author_date: commit.commit?.author?.date || '',
            committer_name: commit.commit?.committer?.name || '',
            committer_email: commit.commit?.committer?.email || '',
            committer_date: commit.commit?.committer?.date || '',
            url: commit.html_url,
            additions: commit.stats?.additions || 0,
            deletions: commit.stats?.deletions || 0,
            total_changes: (commit.stats?.additions || 0) + (commit.stats?.deletions || 0),
            files_changed: commit.files?.length || 0,
            parent_count: commit.parents?.length || 0,
          });
        });

        hasMore = response.data.length === 100;
        page++;
      }
    } catch (err) {
      // Skip repos with permission issues
    }
  }

  return commits;
}

// ============= PULL REQUESTS DATA =============
async function collectPullRequests(octokit, username, repos) {
  console.log('🔀 Collecting pull requests...');
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

        response.data.forEach(pr => {
          prs.push({
            repo_name: repo.name,
            repo_id: repo.id,
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            merged: pr.merged || false,
            merged_at: pr.merged_at,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at,
            additions: pr.additions || 0,
            deletions: pr.deletions || 0,
            total_changes: (pr.additions || 0) + (pr.deletions || 0),
            changed_files: pr.changed_files || 0,
            commits: pr.commits || 0,
            comments: pr.comments || 0,
            review_comments: pr.review_comments || 0,
            url: pr.html_url,
          });
        });

        hasMore = response.data.length === 100;
        page++;
      }
    } catch (err) {
      // Skip if error
    }
  }

  return prs;
}

// ============= ISSUES DATA =============
async function collectIssues(octokit, username, repos) {
  console.log('🐛 Collecting issues...');
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

        response.data.forEach(issue => {
          // Skip pull requests (they appear in issues API too)
          if (!issue.pull_request) {
            issues.push({
              repo_name: repo.name,
              repo_id: repo.id,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels?.map(l => l.name) || [],
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              closed_at: issue.closed_at,
              comments: issue.comments || 0,
              url: issue.html_url,
            });
          }
        });

        hasMore = response.data.length === 100;
        page++;
      }
    } catch (err) {
      // Skip if error
    }
  }

  return issues;
}

// ============= CODE REVIEWS DATA =============
async function collectCodeReviews(octokit, username, repos) {
  console.log('👀 Collecting code reviews...');
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
                  repo_id: repo.id,
                  pr_number: pr.number,
                  pr_title: pr.title,
                  state: review.state,
                  submitted_at: review.submitted_at,
                  body: review.body,
                  url: review.html_url,
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

// ============= ACTIVITY/EVENTS DATA =============
async function collectActivityEvents(octokit, username) {
  console.log('📊 Collecting activity events...');
  try {
    const events = await octokit.rest.activity.listPublicEventsForUser({
      username,
      per_page: 100,
    });

    return events.data.map(e => ({
      type: e.type,
      repo: e.repo?.name,
      created_at: e.created_at,
      payload: e.payload,
    }));
  } catch (err) {
    return [];
  }
}

// ============= FOLLOWERS/FOLLOWING DATA =============
async function collectFollows(octokit, username) {
  console.log('👥 Collecting followers/following...');

  const followers = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await octokit.rest.users.listFollowersForUser({
      username,
      per_page: 100,
      page,
    });

    followers.push(...response.data.map(u => ({ login: u.login, id: u.id, avatar_url: u.avatar_url })));
    hasMore = response.data.length === 100;
    page++;
  }

  const following = [];
  page = 1;
  hasMore = true;

  while (hasMore) {
    const response = await octokit.rest.users.listFollowingForUser({
      username,
      per_page: 100,
      page,
    });

    following.push(...response.data.map(u => ({ login: u.login, id: u.id, avatar_url: u.avatar_url })));
    hasMore = response.data.length === 100;
    page++;
  }

  return { followers, following };
}

// ============= MAIN COLLECTION FUNCTION =============
async function collectAllData(token) {
  const octokit = new (require('octokit')).Octokit({ auth: token });

  console.log('\n🚀 Starting comprehensive GitHub data collection...\n');

  const currentUser = await getCurrentUser(octokit);
  const username = currentUser.login;

  console.log(`✅ Authenticated as: ${username}\n`);

  // Collect all data
  const profile = await collectUserProfile(octokit, username);
  const repositories = await collectRepositories(octokit, username);
  const commits = await collectCommits(octokit, username, repositories);
  const prs = await collectPullRequests(octokit, username, repositories);
  const issues = await collectIssues(octokit, username, repositories);
  const reviews = await collectCodeReviews(octokit, username, repositories);
  const events = await collectActivityEvents(octokit, username);
  const follows = await collectFollows(octokit, username);

  // Save all data
  saveData(username, 'profile', profile);
  saveData(username, 'repositories', repositories);
  saveData(username, 'commits', commits);
  saveData(username, 'pull-requests', prs);
  saveData(username, 'issues', issues);
  saveData(username, 'code-reviews', reviews);
  saveData(username, 'activity-events', events);
  saveData(username, 'follows', follows);

  console.log(`\n✅ Data collection complete!\n`);
  console.log(`📊 Summary:`);
  console.log(`   Profile: 1 record`);
  console.log(`   Repositories: ${repositories.length}`);
  console.log(`   Commits: ${commits.length}`);
  console.log(`   Pull Requests: ${prs.length}`);
  console.log(`   Issues: ${issues.length}`);
  console.log(`   Code Reviews: ${reviews.length}`);
  console.log(`   Activity Events: ${events.length}`);
  console.log(`   Followers: ${follows.followers.length}`);
  console.log(`   Following: ${follows.following.length}\n`);

  return { username, profile, repositories, commits, prs, issues, reviews, events, follows };
}

// ============= API ROUTES =============

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.post('/api/collect', async (req, res) => {
  try {
    const token = req.body?.token || GITHUB_TOKEN;

    if (!token) {
      return res.status(400).json({ error: 'GITHUB_TOKEN required' });
    }

    const result = await collectAllData(token);
    res.json({ success: true, message: 'Data collection complete', username: result.username });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data/:username/:dataType', (req, res) => {
  const { username, dataType } = req.params;
  const file = getDataFile(username, dataType);

  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'Data not found' });
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json(data);
});

app.get('/api/available', (req, res) => {
  const files = fs.readdirSync(CACHE_DIR);
  const users = {};

  files.forEach(file => {
    const [username, dataType] = file.replace('.json', '').split('-').slice(0, -1).join('-').split('-');
    const type = file.split('-').pop().replace('.json', '');

    if (!users[username]) users[username] = [];
    users[username].push(type);
  });

  res.json(users);
});

app.get('/', (req, res) => {
  const files = fs.readdirSync(CACHE_DIR);

  if (files.length === 0 && !GITHUB_TOKEN) {
    return res.send(`
      <html>
      <head><title>GitHub Data Collector</title>
      <style>
        body { font-family: Arial; background: #f5f5f5; padding: 40px; }
        .card { background: white; padding: 40px; border-radius: 8px; text-align: center; max-width: 600px; margin: 0 auto; }
        h1 { color: #0f172a; margin: 0 0 16px; }
        p { color: #64748b; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
        button:hover { background: #2563eb; }
      </style>
      </head>
      <body>
      <div class="card">
        <h1>📊 GitHub Data Collector</h1>
        <p>Enter your GitHub token to collect comprehensive data</p>
        <input type="password" id="token" placeholder="ghp_...">
        <button onclick="collect()">Collect Data</button>
        <div id="status" style="margin-top: 20px;"></div>
      </div>
      <script>
        async function collect() {
          const token = document.getElementById('token').value;
          document.getElementById('status').innerHTML = '⏳ Collecting...';
          const res = await fetch('/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
          const data = await res.json();
          if (res.ok) { document.getElementById('status').innerHTML = '✅ Done! Reloading...'; setTimeout(() => location.reload(), 2000); }
          else { document.getElementById('status').innerHTML = '❌ ' + data.error; }
        }
      </script>
      </body>
      </html>
    `);
  }

  const availableUsers = {};
  files.forEach(file => {
    const parts = file.replace('.json', '').split('-');
    const dataType = parts[parts.length - 1];
    const username = parts.slice(0, -1).join('-');

    if (!availableUsers[username]) availableUsers[username] = [];
    if (!availableUsers[username].includes(dataType)) {
      availableUsers[username].push(dataType);
    }
  });

  const userList = Object.entries(availableUsers)
    .map(([user, types]) => `
      <tr>
        <td><strong>${user}</strong></td>
        <td>${types.join(', ')}</td>
        <td>
          <a href="/api/data/${user}/profile" style="color: #3b82f6; text-decoration: none; margin-right: 10px;">View Profile</a>
          <a href="/api/data/${user}/commits" style="color: #3b82f6; text-decoration: none;">View Commits</a>
        </td>
      </tr>
    `)
    .join('');

  res.send(`
    <html>
    <head><title>GitHub Data Store</title>
    <style>
      body { font-family: Arial; background: #f5f5f5; padding: 40px; }
      .card { background: white; padding: 30px; border-radius: 8px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
      th { background: #f8fafc; font-weight: bold; }
      a { color: #3b82f6; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
    </head>
    <body>
    <div class="card">
      <h1>📊 GitHub Data Store</h1>
      <table>
        <thead><tr><th>User</th><th>Data Types</th><th>Actions</th></tr></thead>
        <tbody>${userList}</tbody>
      </table>
    </div>
    </body>
    </html>
  `);
});

const PORT = process.env.GITHUB_PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n🚀 GitHub Data Collector: http://localhost:${PORT}`);

  if (GITHUB_TOKEN) {
    console.log(`\n⏳ Auto-collecting data with token from .env...\n`);
    try {
      await collectAllData(GITHUB_TOKEN);
    } catch (err) {
      console.error('Auto-collect failed:', err.message);
    }
  }
});
