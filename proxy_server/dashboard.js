/**
 * dashboard.js — Dashboard refresh logic
 * Served as a static asset so the dashboard HTML can use a strict CSP
 * without 'unsafe-inline' for scripts.
 */
(function() {
  let startTime = Date.now();
  let lastError = false;

  function refresh() {
    fetch('/health')
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(d) {
        document.getElementById('stat-sessions').textContent = d.activeSessions;
        document.getElementById('stat-pending').textContent = d.pendingCommands;
        document.getElementById('stat-hermes').textContent = d.hermesClients;
        document.getElementById('stat-bp').textContent = d.backpressureActive ? '⏸' : '✅';
        var elapsed = Math.floor((Date.now() - startTime) / 1000);
        document.getElementById('uptime').textContent = 'up ' + elapsed + 's';
        if (lastError) {
          document.getElementById('error-banner').classList.remove('visible');
          lastError = false;
        }
      })
      .catch(function(e) {
        document.getElementById('error-banner').classList.add('visible');
        lastError = true;
        var elapsed = Math.floor((Date.now() - startTime) / 1000);
        document.getElementById('uptime').textContent = 'down (last seen ' + elapsed + 's ago)';
      });
  }
  refresh();
  setInterval(refresh, 5000);
})();
