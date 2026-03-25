// Auto-generated dashboard HTML template
export const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Product Engineer Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1419;
      color: #e6edf3;
      padding: 20px;
      line-height: 1.6;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid #30363d;
    }

    h1 {
      font-size: 28px;
      font-weight: 600;
    }

    .header-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .user-info {
      padding: 8px 16px;
      background: #161b22;
      border-radius: 6px;
      font-size: 14px;
    }

    button {
      padding: 8px 16px;
      background: #238636;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }

    button:hover {
      background: #2ea043;
    }

    button.danger {
      background: #da3633;
    }

    button.danger:hover {
      background: #f85149;
    }

    button:disabled {
      background: #30363d;
      cursor: not-allowed;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }

    .summary-card {
      background: #161b22;
      padding: 20px;
      border-radius: 8px;
      border: 1px solid #30363d;
    }

    .summary-card h3 {
      font-size: 14px;
      color: #8b949e;
      margin-bottom: 8px;
      font-weight: 500;
    }

    .summary-card .value {
      font-size: 32px;
      font-weight: 600;
    }

    .section {
      margin-bottom: 30px;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .section h2 {
      font-size: 20px;
      font-weight: 600;
    }

    .agent-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 12px;
      transition: border-color 0.2s;
    }

    .agent-card:hover {
      border-color: #58a6ff;
    }

    .agent-card.needs-help {
      border-color: #f85149;
      background: #1c1917;
    }

    .agent-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .agent-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .agent-id {
      font-size: 18px;
      font-weight: 600;
      font-family: 'Monaco', 'Courier New', monospace;
    }

    .status-badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-in_progress { background: #1f6feb; color: white; }
    .status-pr_open { background: #8250df; color: white; }
    .status-in_review { background: #8250df; color: white; }
    .status-needs_revision { background: #d29922; color: white; }
    .status-asking { background: #da3633; color: white; }
    .status-failed { background: #da3633; color: white; }
    .status-merged { background: #238636; color: white; }

    .health-indicator {
      font-size: 20px;
      line-height: 1;
    }

    .agent-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 12px;
      margin-bottom: 12px;
      font-size: 14px;
      color: #8b949e;
    }

    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .meta-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .meta-value {
      color: #e6edf3;
    }

    .meta-value a {
      color: #58a6ff;
      text-decoration: none;
    }

    .meta-value a:hover {
      text-decoration: underline;
    }

    .agent-actions {
      display: flex;
      gap: 8px;
    }

    .agent-actions button {
      padding: 6px 12px;
      font-size: 13px;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #8b949e;
    }

    .loading {
      text-align: center;
      padding: 60px 20px;
      font-size: 18px;
      color: #8b949e;
    }

    .error {
      background: #1c1917;
      border: 1px solid #f85149;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      color: #f85149;
    }

    .refresh-info {
      text-align: center;
      color: #8b949e;
      font-size: 14px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 Product Engineer Dashboard</h1>
      <div class="header-actions">
        <div class="user-info" id="user-info">Loading...</div>
        <button onclick="refreshData()">Refresh</button>
        <button class="danger" onclick="shutdownAll()">Shutdown All Agents</button>
      </div>
    </header>

    <div id="error-container"></div>

    <div class="summary" id="summary">
      <div class="summary-card">
        <h3>Active Agents</h3>
        <div class="value" id="active-count">-</div>
      </div>
      <div class="summary-card">
        <h3>Needs Help</h3>
        <div class="value" id="needs-help-count">-</div>
      </div>
      <div class="summary-card">
        <h3>Completed (24h)</h3>
        <div class="value" id="completed-count">-</div>
      </div>
      <div class="summary-card">
        <h3>Stale (>30min)</h3>
        <div class="value" id="stale-count">-</div>
      </div>
    </div>

    <div id="content">
      <div class="loading">Loading agent status...</div>
    </div>

    <div class="refresh-info">
      Auto-refreshes every 30 seconds
    </div>
  </div>

  <script>
    let refreshInterval;

    async function fetchWithAuth(url, options = {}) {
      const response = await fetch(url, {
        ...options,
        credentials: 'include'
      });

      if (response.status === 401) {
        window.location.href = '/dashboard/login';
        throw new Error('Unauthorized');
      }

      return response;
    }

    async function loadUserInfo() {
      try {
        const response = await fetchWithAuth('/dashboard/user');
        const data = await response.json();
        document.getElementById('user-info').textContent = data.email;
      } catch (error) {
        console.error('Failed to load user info:', error);
      }
    }

    async function loadData() {
      try {
        const response = await fetchWithAuth('/api/conductor/status', {
          headers: {
            'X-API-Key': 'dashboard'
          }
        });

        if (!response.ok) {
          throw new Error(\`HTTP \${response.status}\`);
        }

        const data = await response.json();
        renderDashboard(data);
        document.getElementById('error-container').innerHTML = '';
      } catch (error) {
        console.error('Failed to load data:', error);
        document.getElementById('error-container').innerHTML = \`
          <div class="error">
            Failed to load agent status: \${error.message}
          </div>
        \`;
      }
    }

    function renderDashboard(data) {
      // Update summary
      document.getElementById('active-count').textContent = data.summary.totalActive;
      const needsHelpCount = data.activeAgents.filter(a => a.status === 'asking' || a.status === 'failed').length;
      document.getElementById('needs-help-count').textContent = needsHelpCount;
      document.getElementById('completed-count').textContent = data.summary.totalCompleted;
      document.getElementById('stale-count').textContent = data.summary.totalStale;

      // Separate agents by status
      const needsHelp = data.activeAgents.filter(a => a.status === 'asking' || a.status === 'failed');
      const others = data.activeAgents.filter(a => a.status !== 'asking' && a.status !== 'failed');

      let html = '';

      // Needs Help section
      if (needsHelp.length > 0) {
        html += \`
          <div class="section">
            <div class="section-header">
              <h2>⚠️ Agents Needing Help</h2>
            </div>
            \${needsHelp.map(agent => renderAgentCard(agent, true)).join('')}
          </div>
        \`;
      }

      // Active agents section
      if (others.length > 0) {
        html += \`
          <div class="section">
            <div class="section-header">
              <h2>Active Agents</h2>
            </div>
            \${others.map(agent => renderAgentCard(agent, false)).join('')}
          </div>
        \`;
      }

      // Empty state
      if (data.activeAgents.length === 0) {
        html += \`
          <div class="empty-state">
            <h3>No active agents</h3>
            <p>All quiet on the Product Engineer front.</p>
          </div>
        \`;
      }

      document.getElementById('content').innerHTML = html;
    }

    function renderAgentCard(agent, needsHelp) {
      const healthEmoji = getHealthEmoji(agent.last_heartbeat);
      const timeAgo = getTimeAgo(agent.updated_at);
      const slackLink = agent.slack_thread_ts && agent.slack_channel
        ? \`https://slack.com/app_redirect?channel=\${agent.slack_channel}&message_ts=\${agent.slack_thread_ts}\`
        : null;

      return \`
        <div class="agent-card \${needsHelp ? 'needs-help' : ''}">
          <div class="agent-header">
            <div class="agent-title">
              <span class="health-indicator">\${healthEmoji}</span>
              <span class="agent-id">\${escapeHtml(agent.id)}</span>
              <span class="status-badge status-\${agent.status}">\${agent.status.replace('_', ' ')}</span>
            </div>
            <div class="agent-actions">
              \${slackLink ? \`<button onclick="window.open('\${slackLink}', '_blank')">Open Thread</button>\` : ''}
              <button class="danger" onclick="killAgent('\${escapeHtml(agent.id)}')">Kill Agent</button>
            </div>
          </div>
          <div class="agent-meta">
            <div class="meta-item">
              <div class="meta-label">Product</div>
              <div class="meta-value">\${escapeHtml(agent.product)}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Last Update</div>
              <div class="meta-value">\${timeAgo}</div>
            </div>
            \${agent.pr_url ? \`
              <div class="meta-item">
                <div class="meta-label">Pull Request</div>
                <div class="meta-value"><a href="\${escapeHtml(agent.pr_url)}" target="_blank">\${agent.pr_url.split('/').pop()}</a></div>
              </div>
            \` : ''}
            \${agent.branch_name ? \`
              <div class="meta-item">
                <div class="meta-label">Branch</div>
                <div class="meta-value">\${escapeHtml(agent.branch_name)}</div>
              </div>
            \` : ''}
          </div>
        </div>
      \`;
    }

    function getHealthEmoji(lastHeartbeat) {
      if (!lastHeartbeat) return '❓';
      const minutesSince = Math.floor((Date.now() - new Date(lastHeartbeat).getTime()) / 60000);
      if (minutesSince < 5) return '💚';
      if (minutesSince < 15) return '💛';
      if (minutesSince < 30) return '🧡';
      return '❤️';
    }

    function getTimeAgo(timestamp) {
      const now = Date.now();
      const then = new Date(timestamp).getTime();
      const diffMs = now - then;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return \`\${diffMins}m ago\`;
      if (diffHours < 24) return \`\${diffHours}h ago\`;
      return \`\${diffDays}d ago\`;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    async function killAgent(taskId) {
      if (!confirm(\`Are you sure you want to kill the agent for \${taskId}?\`)) {
        return;
      }

      try {
        const response = await fetchWithAuth(\`/api/dashboard/agents/\${encodeURIComponent(taskId)}/kill\`, {
          method: 'POST'
        });

        if (response.ok) {
          await loadData();
        } else {
          alert('Failed to kill agent');
        }
      } catch (error) {
        console.error('Failed to kill agent:', error);
        alert('Failed to kill agent');
      }
    }

    async function shutdownAll() {
      if (!confirm('Are you sure you want to shut down ALL active agents? This cannot be undone.')) {
        return;
      }

      try {
        const response = await fetchWithAuth('/api/conductor/shutdown-all', {
          method: 'POST',
          headers: {
            'X-API-Key': 'dashboard'
          }
        });

        if (response.ok) {
          await loadData();
          alert('All agents have been shut down');
        } else {
          alert('Failed to shutdown agents');
        }
      } catch (error) {
        console.error('Failed to shutdown agents:', error);
        alert('Failed to shutdown agents');
      }
    }

    function refreshData() {
      loadData();
    }

    // Initial load
    loadUserInfo();
    loadData();

    // Auto-refresh every 30 seconds
    refreshInterval = setInterval(loadData, 30000);

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    });
  </script>
</body>
</html>
`;
