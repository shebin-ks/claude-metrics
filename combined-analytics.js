/**
 * Combined Analytics - GitHub + Claude Code Telemetry
 * Merges GitHub performance metrics with Claude Code usage metrics
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const GITHUB_API = 'http://localhost:3001';
const CLAUDE_API = 'http://localhost:3000';
const DATA_FILE = path.join(__dirname, 'data.json');

async function getGitHubData(username, token) {
  try {
    const response = await fetch(
      `${GITHUB_API}/api/github/user/${username}?token=${token}`
    );
    return await response.json();
  } catch (err) {
    console.error(`Failed to fetch GitHub data for ${username}:`, err.message);
    return null;
  }
}

function getClaudeCodeData(email) {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return data.userSessions[email] || null;
  } catch (err) {
    console.error(`Failed to read Claude Code data:`, err.message);
    return null;
  }
}

function calculateMetrics(github, claude) {
  if (!github || !claude) {
    return { error: 'Missing data' };
  }

  const contrib = github.contributions || {};
  const repos = github.repositories || {};
  const profile = github.profile || {};

  return {
    // Activity Metrics
    activity: {
      commitFrequency: contrib.totalCommits,
      pullRequestVelocity: contrib.prsCreated,
      pullRequestQuality: contrib.prsMerged / (contrib.prsCreated || 1),
      codeReviewEngagement: contrib.codeReviews,
      issueManagement: contrib.issuesClosed / (contrib.issuesCreated || 1),
      lastActivityDaysAgo: Math.floor(
        (Date.now() - new Date(contrib.lastActivityDate).getTime()) /
          (1000 * 60 * 60 * 24)
      ),
    },

    // Impact Metrics
    impact: {
      totalStars: repos.totalStars,
      totalForks: repos.totalForks,
      repositoryCount: repos.totalRepos,
      followers: profile.followers,
      influence: Math.min(100, (profile.followers / 1000) * 100),
    },

    // Technical Metrics
    technical: {
      languageCount: Object.keys(github.languages || {}).length,
      topLanguages: Object.entries(github.languages || {})
        .slice(0, 3)
        .map(([lang, pct]) => ({ language: lang, percentage: pct })),
    },

    // Claude Code Usage
    claudeUsage: {
      totalCost: Object.values(claude).reduce(
        (sum, session) => sum + (session.cost || 0),
        0
      ),
      totalInputTokens: Object.values(claude).reduce(
        (sum, session) => sum + (session.inputTokens || 0),
        0
      ),
      totalOutputTokens: Object.values(claude).reduce(
        (sum, session) => sum + (session.outputTokens || 0),
        0
      ),
      sessionCount: Object.keys(claude).length,
      averageCostPerSession: 0,
    },

    // Composite Scores
    scores: {
      productivityScore: calculateProductivityScore(contrib, repos),
      codeQualityScore: calculateCodeQualityScore(contrib),
      influenceScore: calculateInfluenceScore(profile, repos),
      techDiversityScore: calculateTechDiversityScore(github.languages),
      aiUsageIntensity: calculateAIIntensity(Object.keys(claude).length, contrib),
    },
  };
}

function calculateProductivityScore(contrib, repos) {
  const commitWeight = Math.min(contrib.totalCommits / 200, 1);
  const prWeight = Math.min(contrib.prsCreated / 50, 1);
  const repoWeight = Math.min(repos.totalRepos / 50, 1);

  return Math.round((commitWeight * 0.5 + prWeight * 0.3 + repoWeight * 0.2) * 100);
}

function calculateCodeQualityScore(contrib) {
  const mergeRate = contrib.prsCreated > 0
    ? contrib.prsMerged / contrib.prsCreated
    : 0;
  const reviewRate = Math.min(contrib.codeReviews / (contrib.prsCreated || 1), 1);

  return Math.round((mergeRate * 0.6 + reviewRate * 0.4) * 100);
}

function calculateInfluenceScore(profile, repos) {
  const followerScore = Math.min((profile.followers || 0) / 10000, 1);
  const starScore = Math.min((repos.totalStars || 0) / 10000, 1);

  return Math.round((followerScore * 0.5 + starScore * 0.5) * 100);
}

function calculateTechDiversityScore(languages) {
  const langCount = Object.keys(languages || {}).length;
  return Math.round((langCount / 10) * 100);
}

function calculateAIIntensity(sessionCount, contrib) {
  // Score based on how much they might be using AI in their workflow
  const commitRatio = contrib.totalCommits > 0 ? sessionCount / contrib.totalCommits : 0;
  return Math.round(Math.min(commitRatio * 100, 100));
}

function generateReport(metrics) {
  const separator = '─'.repeat(60);

  const report = `
╔════════════════════════════════════════════════════════════╗
║           DEVELOPER PERFORMANCE ANALYTICS                  ║
╚════════════════════════════════════════════════════════════╝

📊 ACTIVITY METRICS
${separator}
  Commits:               ${metrics.activity.commitFrequency}
  Pull Requests:        ${metrics.activity.pullRequestVelocity} created, ${Math.round(metrics.activity.pullRequestQuality * 100)}% merged
  Code Reviews:         ${metrics.activity.codeReviewEngagement}
  Issues Closed:        ${Math.round(metrics.activity.issueManagement * 100)}% resolution rate
  Last Activity:        ${metrics.activity.lastActivityDaysAgo} days ago

🚀 IMPACT METRICS
${separator}
  Repository Stars:     ${metrics.impact.totalStars.toLocaleString()}
  Repository Forks:     ${metrics.impact.totalForks.toLocaleString()}
  Public Repositories:  ${metrics.impact.repositoryCount}
  Followers:            ${metrics.impact.followers.toLocaleString()}
  Influence Score:      ${metrics.impact.influence.toFixed(1)}/100

🛠️ TECHNICAL SKILLS
${separator}
  Languages Used:       ${metrics.technical.languageCount}
  ${metrics.technical.topLanguages.map(l => `${l.language}: ${l.percentage}`).join('\n  ')}

💰 AI USAGE (Claude Code)
${separator}
  Total Cost:           $${metrics.claudeUsage.totalCost.toFixed(2)}
  Input Tokens:         ${metrics.claudeUsage.totalInputTokens.toLocaleString()}
  Output Tokens:        ${metrics.claudeUsage.totalOutputTokens.toLocaleString()}
  Sessions:             ${metrics.claudeUsage.sessionCount}

⭐ COMPOSITE SCORES
${separator}
  Productivity:         ${metrics.scores.productivityScore}/100
  Code Quality:         ${metrics.scores.codeQualityScore}/100
  Influence:            ${metrics.scores.influenceScore}/100
  Tech Diversity:       ${metrics.scores.techDiversityScore}/100
  AI Usage Intensity:   ${metrics.scores.aiUsageIntensity}/100

  OVERALL SCORE:        ${Math.round(
    (metrics.scores.productivityScore +
      metrics.scores.codeQualityScore +
      metrics.scores.influenceScore +
      metrics.scores.techDiversityScore) / 4
  )}/100
`;

  return report;
}

async function analyzeUser(username, email, githubToken) {
  console.log(`\n📈 Analyzing ${username} (${email})...\n`);

  const github = await getGitHubData(username, githubToken);
  const claude = getClaudeCodeData(email);

  if (!github) {
    console.error(`❌ Could not fetch GitHub data for ${username}`);
    return;
  }

  if (!claude) {
    console.error(`⚠️  No Claude Code data found for ${email}`);
  }

  const metrics = calculateMetrics(github, claude);
  const report = generateReport(metrics);

  console.log(report);

  // Save metrics to file
  const filename = path.join(__dirname, `analytics-${username}.json`);
  fs.writeFileSync(
    filename,
    JSON.stringify({ username, email, metrics, generatedAt: new Date().toISOString() }, null, 2)
  );

  console.log(`\n✅ Report saved to ${filename}\n`);

  return metrics;
}

async function compareDevelopers(developers, githubToken) {
  console.log('\n📊 COMPARING DEVELOPERS\n');

  const results = {};

  for (const [username, email] of developers) {
    const github = await getGitHubData(username, githubToken);
    const claude = getClaudeCodeData(email);
    results[username] = calculateMetrics(github, claude);
  }

  // Sort by overall score
  const sorted = Object.entries(results)
    .map(([username, metrics]) => ({
      username,
      score:
        (metrics.scores.productivityScore +
          metrics.scores.codeQualityScore +
          metrics.scores.influenceScore) /
        3,
      metrics,
    }))
    .sort((a, b) => b.score - a.score);

  console.log('Ranking:');
  console.log('─'.repeat(60));
  sorted.forEach((dev, i) => {
    console.log(
      `${i + 1}. ${dev.username.padEnd(20)} - Score: ${Math.round(dev.score)}/100`
    );
  });

  return sorted;
}

// Example usage
if (require.main === module) {
  const githubToken = process.env.GITHUB_TOKEN || '';

  if (!githubToken) {
    console.log('Usage: GITHUB_TOKEN=your_token node combined-analytics.js');
    console.log('\nExample:');
    console.log('  GITHUB_TOKEN=ghp_xxx node combined-analytics.js');
    process.exit(1);
  }

  // Analyze a single user
  analyzeUser('torvalds', 'torvalds@example.com', githubToken).catch(console.error);

  // Compare multiple developers
  // compareDevelopers(
  //   [
  //     ['torvalds', 'torvalds@example.com'],
  //     ['guido', 'guido@example.com'],
  //   ],
  //   githubToken
  // ).catch(console.error);
}

module.exports = { analyzeUser, compareDevelopers, calculateMetrics };
