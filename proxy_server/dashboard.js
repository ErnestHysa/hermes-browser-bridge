/**
 * dashboard.js — Dashboard refresh logic
 * Served as a static asset so the dashboard HTML can use a strict CSP
 * without 'unsafe-inline' for scripts.
 */
(function() {
  let startTime = Date.now();
  function refresh() {
    fetch('/health')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        document.getElementById('stat-sessions').textContent = d.activeSessions;
        document.getElementById('stat-pending').textContent = d.pendingCommands;
        document.getElementById('stat-hermes').textContent = d.hermesClients;
        document.getElementById('stat-bp').textContent = d.backpressureActive ? '⏸' : '✅';
        var elapsed = Math.floor((Date.now() - startTime) / 1000);
        document.getElementById('uptime').textContent = 'up ' + elapsed + 's';
      })
      .catch(function() {});
  }
  refresh();
  setInterval(refresh, 5000);
})();
