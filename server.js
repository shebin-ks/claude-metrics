const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

app.use((req, res, next) => {
  if (req.method !== 'GET') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

const DATA_FILE = path.join(__dirname, 'data.json');

let userSessions = {};
let metricEvents = [];

if (fs.existsSync(DATA_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    userSessions = parsed.userSessions || parsed;
    metricEvents = parsed.metricEvents || [];
  } catch (err) {
    console.error('Error reading data file:', err);
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ userSessions, metricEvents }, null, 2), 'utf8');
}

function initSession(email, sessionId) {
  if (!userSessions[email]) userSessions[email] = {};
  if (!userSessions[email][sessionId]) {
    userSessions[email][sessionId] = {
      date: new Date().toISOString(),
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    };
  }
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/v1/metrics', (req, res) => {
  try {
    const resourceMetrics = req.body.resourceMetrics;
    if (!resourceMetrics) return res.sendStatus(200);

    // One combined event per email+sessionId per OTLP batch
    const batchEvents = {};

    resourceMetrics.forEach(rm => {
      rm.scopeMetrics?.forEach(sm => {
        sm.metrics?.forEach(metric => {
          const isDelta = metric.sum?.aggregationTemporality === 1;

          if (metric.name === 'claude_code.cost.usage') {
            metric.sum?.dataPoints?.forEach(dp => {
              const attrs = getAttributesObj(dp.attributes);
              const email = attrs['user.email'];
              const sessionId = attrs['session.id'];
              if (!email || !sessionId) return;

              initSession(email, sessionId);
              const costVal = parseFloat(dp.value ?? dp.asDouble ?? 0);
              const increment = isDelta
                ? costVal
                : Math.max(0, costVal - userSessions[email][sessionId].cost);

              const evt = getBatchEvent(batchEvents, email, sessionId, attrs);
              if (increment > 0) evt.costIncrement += increment;

              if (isDelta) {
                userSessions[email][sessionId].cost += costVal;
              } else {
                userSessions[email][sessionId].cost = Math.max(userSessions[email][sessionId].cost, costVal);
              }
              userSessions[email][sessionId].date = new Date().toISOString();
            });
          }

          if (metric.name === 'claude_code.token.usage') {
            metric.sum?.dataPoints?.forEach(dp => {
              const attrs = getAttributesObj(dp.attributes);
              const email = attrs['user.email'];
              const sessionId = attrs['session.id'];
              const type = attrs['type'];
              if (!email || !sessionId) return;

              initSession(email, sessionId);
              const intVal = parseInt(dp.value ?? dp.asInt ?? dp.asDouble ?? 0, 10) || 0;
              const prevVal = userSessions[email][sessionId][`${type}Tokens`] || 0;
              const increment = isDelta ? intVal : Math.max(0, intVal - prevVal);

              const evt = getBatchEvent(batchEvents, email, sessionId, attrs);
              if (increment > 0) {
                if (type === 'input') evt.inputTokens += increment;
                else if (type === 'output') evt.outputTokens += increment;
                else if (type === 'cacheRead') evt.cacheReadTokens += increment;
                else if (type === 'cacheCreation') evt.cacheCreationTokens += increment;
              }

              if (isDelta) {
                if (type === 'input') userSessions[email][sessionId].inputTokens += intVal;
                else if (type === 'output') userSessions[email][sessionId].outputTokens += intVal;
                else if (type === 'cacheRead') userSessions[email][sessionId].cacheReadTokens += intVal;
                else if (type === 'cacheCreation') userSessions[email][sessionId].cacheCreationTokens += intVal;
              } else {
                if (type === 'input') userSessions[email][sessionId].inputTokens = Math.max(userSessions[email][sessionId].inputTokens, intVal);
                else if (type === 'output') userSessions[email][sessionId].outputTokens = Math.max(userSessions[email][sessionId].outputTokens, intVal);
                else if (type === 'cacheRead') userSessions[email][sessionId].cacheReadTokens = Math.max(userSessions[email][sessionId].cacheReadTokens, intVal);
                else if (type === 'cacheCreation') userSessions[email][sessionId].cacheCreationTokens = Math.max(userSessions[email][sessionId].cacheCreationTokens, intVal);
              }
              userSessions[email][sessionId].date = new Date().toISOString();
            });
          }
        });
      });
    });

    const now = new Date().toISOString();
    Object.values(batchEvents).forEach(evt => {
      if (evt.costIncrement > 0 || evt.inputTokens > 0 || evt.outputTokens > 0) {
        metricEvents.push({ date: now, ...evt });
      }
    });

    saveData();
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing metrics:', err);
    res.sendStatus(500);
  }
});

function getBatchEvent(batchEvents, email, sessionId, attrs) {
  const key = `${email}::${sessionId}`;
  if (!batchEvents[key]) {
    batchEvents[key] = {
      email,
      sessionId,
      costIncrement: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      // All available OTLP attributes
      model: attrs['model'] || null,
      querySource: attrs['query_source'] || null,
      organizationId: attrs['organization.id'] || null,
      userId: attrs['user.id'] || null,
      accountId: attrs['user.account_id'] || null,
      accountUuid: attrs['user.account_uuid'] || null,
    };
  }
  // Fill in attrs that may only appear on later data points
  if (!batchEvents[key].model && attrs['model']) batchEvents[key].model = attrs['model'];
  if (!batchEvents[key].querySource && attrs['query_source']) batchEvents[key].querySource = attrs['query_source'];
  return batchEvents[key];
}

function getAttributesObj(attributesArray) {
  const obj = {};
  if (!attributesArray) return obj;
  attributesArray.forEach(attr => {
    const v = attr.value;
    if (!v) return;
    if (v.stringValue !== undefined) obj[attr.key] = v.stringValue;
    else if (v.intValue !== undefined) obj[attr.key] = v.intValue;
    else if (v.doubleValue !== undefined) obj[attr.key] = v.doubleValue;
    else if (v.boolValue !== undefined) obj[attr.key] = v.boolValue;
    else obj[attr.key] = String(v);
  });
  return obj;
}

app.get('/', (req, res) => {
  // --- Session totals table ---
  let allSessions = [];
  Object.keys(userSessions).forEach(email => {
    Object.keys(userSessions[email]).forEach(sessionId => {
      allSessions.push({ email, sessionId, ...userSessions[email][sessionId] });
    });
  });
  allSessions.sort((a, b) => new Date(b.date) - new Date(a.date));

  const sessionRows = allSessions.map(s => `
    <tr>
      <td>${new Date(s.date).toLocaleString()}</td>
      <td>${s.email}</td>
      <td><code class="mono">${s.sessionId.split('-')[0]}...</code></td>
      <td class="cost">$${Math.max(0, s.cost || 0).toFixed(4)}</td>
      <td>${(s.inputTokens || 0).toLocaleString()}</td>
      <td>${(s.outputTokens || 0).toLocaleString()}</td>
      <td>${(s.cacheReadTokens || 0).toLocaleString()}</td>
      <td>${(s.cacheCreationTokens || 0).toLocaleString()}</td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty">No telemetry data yet.</td></tr>';

  // --- Event log table (new-schema only) ---
  const limitParam = req.query.v || req.query.limit;
  const limit = limitParam === 'all' ? metricEvents.length : (parseInt(limitParam) || 100);

  // Deduplicate: 1 row per request (email+sessionId+second), track main vs auxiliary separately
  const deduped = {};
  const sortedEvents = [...metricEvents]
    .filter(e => e.costIncrement !== undefined)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  sortedEvents.forEach(e => {
    const eventTime = new Date(e.date).getTime();
    const roundedTime = Math.floor(eventTime / 1000) * 1000;
    const key = `${e.email}::${e.sessionId}::${roundedTime}`;
    const source = e.querySource || 'unknown';

    if (deduped[key]) {
      // Merge with existing event, track by source
      deduped[key].costIncrement += e.costIncrement;
      deduped[key].inputTokens += e.inputTokens;
      deduped[key].outputTokens += e.outputTokens;
      deduped[key].cacheReadTokens += e.cacheReadTokens;
      deduped[key].cacheCreationTokens += e.cacheCreationTokens;
      // Track breakdown by source
      if (!deduped[key].bySource[source]) {
        deduped[key].bySource[source] = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      }
      deduped[key].bySource[source].cost += e.costIncrement;
      deduped[key].bySource[source].input += e.inputTokens;
      deduped[key].bySource[source].output += e.outputTokens;
      deduped[key].bySource[source].cacheRead += e.cacheReadTokens;
      deduped[key].bySource[source].cacheCreation += e.cacheCreationTokens;
      if (!deduped[key].querySources.includes(source)) {
        deduped[key].querySources.push(source);
      }
    } else {
      const bySource = {};
      bySource[source] = {
        cost: e.costIncrement,
        input: e.inputTokens,
        output: e.outputTokens,
        cacheRead: e.cacheReadTokens,
        cacheCreation: e.cacheCreationTokens
      };
      deduped[key] = {
        ...e,
        querySources: [source],
        bySource
      };
    }
  });

  const recentEvents = Object.values(deduped).slice(0, limit);

  const eventRows = recentEvents.map(e => {
    const bySourceInfo = {};
    const mainMetrics = e.bySource?.main || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const auxMetrics = e.bySource?.auxiliary || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

    if (e.bySource) {
      for (const [source, metrics] of Object.entries(e.bySource)) {
        bySourceInfo[source] = {
          cost: `$${metrics.cost.toFixed(6)}`,
          input_tokens: metrics.input.toLocaleString(),
          output_tokens: metrics.output.toLocaleString(),
          cache_read_tokens: metrics.cacheRead.toLocaleString(),
          cache_creation_tokens: metrics.cacheCreation.toLocaleString()
        };
      }
    }
    const details = {
      'model': e.model,
      'query_sources': e.querySources,
      'breakdown_by_source': bySourceInfo,
      'organization.id': e.organizationId,
      'user.id': e.userId,
      'user.account_id': e.accountId,
      'user.account_uuid': e.accountUuid,
      'session.id': e.sessionId,
    };
    const encoded = encodeURIComponent(JSON.stringify(details, null, 2));
    const modelBadge = e.model
      ? `<span class="badge model-badge" title="${e.model}">${e.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>`
      : '<span class="na">—</span>';

    // Determine which sources are present
    const hasBoth = mainMetrics.input > 0 && auxMetrics.input > 0;
    const hasMain = mainMetrics.input > 0;
    const hasAux = auxMetrics.input > 0;
    const sourceLabel = hasBoth ? 'main · aux' : (hasAux ? 'auxiliary' : 'main');

    // Show costs: if both exist, show main then aux
    const costDisplay = hasBoth
      ? `<div class="val-main">$${mainMetrics.cost.toFixed(5)}</div><div style="font-size:0.7rem;color:#94a3b8">+ $${auxMetrics.cost.toFixed(5)}</div>`
      : `<div class="val-main">$${e.costIncrement.toFixed(5)}</div>`;

    // Show primary source on top, secondary below
    const primaryInput = hasAux && !hasMain ? auxMetrics.input : mainMetrics.input;
    const secondaryInput = hasBoth ? auxMetrics.input : 0;
    const primaryOutput = hasAux && !hasMain ? auxMetrics.output : mainMetrics.output;
    const secondaryOutput = hasBoth ? auxMetrics.output : 0;
    const primaryCR = hasAux && !hasMain ? auxMetrics.cacheRead : mainMetrics.cacheRead;
    const secondaryCR = hasBoth ? auxMetrics.cacheRead : 0;
    const primaryCC = hasAux && !hasMain ? auxMetrics.cacheCreation : mainMetrics.cacheCreation;
    const secondaryCC = hasBoth ? auxMetrics.cacheCreation : 0;

    return `
    <tr>
      <td class="dim">${new Date(e.date).toLocaleString()}<br><span style="font-size:0.68rem;color:#94a3b8">${new Date(e.date).toLocaleDateString()}</span></td>
      <td class="bold">${e.email}</td>
      <td>${modelBadge}</td>
      <td>${costDisplay}<div class="val-split">${sourceLabel}</div></td>
      <td><div class="val-tok">${primaryInput.toLocaleString()}</div><div style="font-size:0.7rem;color:#94a3b8">${secondaryInput > 0 ? '+ ' + secondaryInput.toLocaleString() : ''}</div></td>
      <td><div class="val-tok">${primaryOutput.toLocaleString()}</div><div style="font-size:0.7rem;color:#94a3b8">${secondaryOutput > 0 ? '+ ' + secondaryOutput.toLocaleString() : ''}</div></td>
      <td><div class="val-tok">${primaryCR.toLocaleString()}</div><div style="font-size:0.7rem;color:#94a3b8">${secondaryCR > 0 ? '+ ' + secondaryCR.toLocaleString() : ''}</div></td>
      <td><div class="val-tok">${primaryCC.toLocaleString()}</div><div style="font-size:0.7rem;color:#94a3b8">${secondaryCC > 0 ? '+ ' + secondaryCC.toLocaleString() : ''}</div></td>
      <td>
        <button onclick="showModal(decodeURIComponent('${encoded}'))" class="icon-btn" title="Details">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
        </button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No events yet.</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Claude Code Telemetry</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box}
    body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#f0f4f8,#d9e2ec);margin:0;padding:24px;color:#334155;min-height:100vh}
    h1{color:#0f172a;font-weight:700;font-size:1.5rem;margin:0 0 4px}
    h2{color:#1e293b;font-weight:600;font-size:1.1rem;margin:0 0 12px}
    .subtitle{font-size:0.82rem;color:#64748b;margin:0 0 16px}
    .card{background:rgba(255,255,255,0.88);backdrop-filter:blur(12px);border-radius:14px;border:1px solid rgba(255,255,255,0.4);box-shadow:0 8px 20px -4px rgba(0,0,0,0.06);padding:24px;margin-bottom:20px;overflow:hidden}
    .scroll{overflow-x:auto;width:100%}
    table{width:100%;border-collapse:collapse;font-size:0.82rem;white-space:nowrap}
    th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #e2e8f0}
    th{background:rgba(248,250,252,0.8);color:#64748b;font-weight:600;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em;border-bottom:2px solid #cbd5e1;position:sticky;top:0}
    tr:hover td{background:rgba(241,245,249,0.6)}
    tr:last-child td{border-bottom:none}
    .cost{font-weight:700;color:#10b981}
    .cost-inc{font-weight:700;color:#ef4444}
    .bold{font-weight:600;color:#1e293b}
    .dim{color:#64748b;font-size:0.78rem}
    .mono{font-size:0.78em;color:#6b7280;background:#f1f5f9;border:1px solid #e2e8f0;padding:2px 5px;border-radius:4px;font-family:monospace}
    .na{color:#cbd5e1}
    .empty{text-align:center;padding:32px;color:#94a3b8;white-space:normal}
    .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:0.72rem;font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
    .model-badge{background:#ede9fe;color:#6d28d9}
    .qs-badge{background:#dbeafe;color:#1d4ed8}
    .val-main{font-weight:700;color:#ef4444;font-size:0.9rem}
    .val-tok{font-weight:600;color:#1e293b}
    .val-split{font-size:0.7rem;color:#94a3b8;margin-top:2px}
    .icon-btn{background:none;border:none;cursor:pointer;color:#6366f1;padding:4px;border-radius:5px;display:inline-flex;align-items:center;transition:background 0.15s,color 0.15s}
    .icon-btn:hover{color:#4338ca;background:#e0e7ff}
    .overlay{position:fixed;inset:0;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;z-index:50;opacity:0;pointer-events:none;transition:opacity 0.2s;backdrop-filter:blur(4px)}
    .overlay.on{opacity:1;pointer-events:auto}
    .modal{background:#fff;border-radius:14px;width:90%;max-width:560px;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);transform:translateY(16px);transition:transform 0.25s cubic-bezier(0.16,1,0.3,1)}
    .overlay.on .modal{transform:translateY(0)}
    .mhdr{padding:12px 18px;border-bottom:1px solid #e2e8f0;background:#f8fafc;display:flex;justify-content:space-between;align-items:center}
    .mhdr h3{margin:0;font-size:0.95rem;color:#1e293b;font-weight:600}
    .mbody{padding:18px;overflow-y:auto;background:#1e293b}
    .mbody pre{margin:0;color:#f8fafc;font-family:monospace;font-size:0.82rem;white-space:pre-wrap;word-break:break-all}
    .close{background:none;border:none;font-size:1.4rem;color:#94a3b8;cursor:pointer;line-height:1;padding:0}
    .close:hover{color:#ef4444}
  </style>
</head>
<body>

<div class="card" style="border-top:4px solid #3b82f6">
  <h1>Claude Code Telemetry</h1>
  <p class="subtitle">Session totals — all users</p>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Last Update</th><th>User Email</th><th>Session</th>
        <th>Total Cost</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Created</th>
      </tr></thead>
      <tbody>${sessionRows}</tbody>
    </table>
  </div>
</div>

<div class="card" style="border-top:4px solid #8b5cf6">
  <h2>Event Log <span style="font-weight:400;font-size:0.82rem;color:#64748b">— last ${limit} events (<a href="?v=all" style="color:#6366f1">view all</a>)</span></h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Time</th><th>User</th><th>Model</th><th>Source</th>
        <th>Cost</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Created</th><th></th>
      </tr></thead>
      <tbody>${eventRows}</tbody>
    </table>
  </div>
</div>

<div id="overlay" class="overlay" onclick="closeModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="mhdr">
      <h3>OTLP Attributes</h3>
      <button class="close" onclick="closeModal()">×</button>
    </div>
    <div class="mbody"><pre id="mpre"></pre></div>
  </div>
</div>

<script>
  function showModal(json) {
    document.getElementById('mpre').textContent = json;
    document.getElementById('overlay').classList.add('on');
  }
  function closeModal(e) {
    if (!e || e.target === document.getElementById('overlay')) {
      document.getElementById('overlay').classList.remove('on');
    }
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
</script>
</body>
</html>`;

  res.send(html);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Claude OTLP Receiver running on http://localhost:${PORT}`);
});
