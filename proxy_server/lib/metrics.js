/**
 * metrics.js — Prometheus-compatible metrics collection and formatting.
 */

'use strict';

const METRIC_TTL_MS = 60000;
const METRIC_MAX_PER_TYPE = 1000;

const metrics = {
  counters: {
    commands: { type: {}, status: {}, total: 0 },
    wsConnections: 0,
    wsMessages: { rx: 0, tx: 0 },
    idempotencyRejections: 0,
    wsSendTimeouts: 0,
    sseStreams: 0,
  },
  gauges: {
    connectedSessions: 0,
    pendingCommands: 0,
    uptimeSeconds: 0,
    hermesClients: 0,
    backpressureActive: 0,
  },
  histograms: {
    commandDuration: {},
    htmlBytes: [],
    mutationBufferSize: [],
  }
};

let _metricLastCleanup = 0;

function metricIncr(counterPath, labels = {}) {
  const parts = counterPath.split('.');
  let node = metrics.counters;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]]) node[parts[i]] = {};
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (!node[last]) node[last] = labels._total ? 0 : {};
  if (labels._total) { node[last]++; return; }
  const labelKeys = Object.keys(labels).sort((a, b) => a.localeCompare(b));
  const key = labelKeys.length > 0
    ? labelKeys.map(k => `${k}="${labels[k]}"`).join(',')
    : '';
  if (!node[last][key]) node[last][key] = 0;
  node[last][key]++;
}

function metricGauge(name, value) {
  if (metrics.gauges[name] !== undefined) metrics.gauges[name] = value;
}

function metricHistogramPush(histName, value, labels = {}) {
  const type = labels.type || 'unknown';
  if (!metrics.histograms[histName][type]) {
    metrics.histograms[histName][type] = [];
  }
  metrics.histograms[histName][type].push({ value, labels, ts: Date.now() });
  const now = Date.now();
  if (!_metricLastCleanup || (now - _metricLastCleanup) > METRIC_TTL_MS) {
    _metricLastCleanup = now;
    for (const [hName, entries] of Object.entries(metrics.histograms)) {
      for (const [type, arr] of Object.entries(entries)) {
        const cutoff = now - METRIC_TTL_MS;
        const valid = arr.filter(e => e.ts > cutoff);
        if (valid.length > METRIC_MAX_PER_TYPE) {
          valid.splice(0, valid.length - METRIC_MAX_PER_TYPE);
        }
        metrics.histograms[hName][type] = valid;
      }
    }
  }
}

function formatPrometheus() {
  const lines = [];
  const emit = (...parts) => lines.push(parts.join(' '));

  emit('# HELP hbs_uptime_seconds Proxy uptime in seconds');
  emit('# TYPE hbs_uptime_seconds gauge');
  emit(`hbs_uptime_seconds ${Math.floor(metrics.gauges.uptimeSeconds)}`);

  emit('# HELP hbs_connected_sessions Number of active extension sessions');
  emit('# TYPE hbs_connected_sessions gauge');
  emit(`hbs_connected_sessions ${metrics.gauges.connectedSessions}`);

  emit('# HELP hbs_pending_commands Number of pending commands in queue');
  emit('# TYPE hbs_pending_commands gauge');
  emit(`hbs_pending_commands ${metrics.gauges.pendingCommands}`);

  emit('# HELP hbs_ws_hermes_clients Number of Hermes WS clients connected');
  emit('# TYPE hbs_ws_hermes_clients gauge');
  emit(`hbs_ws_hermes_clients ${metrics.gauges.hermesClients}`);

  emit('# HELP hbs_backpressure_active Whether backpressure is active (1=paused, 0=normal)');
  emit('# TYPE hbs_backpressure_active gauge');
  emit(`hbs_backpressure_active ${metrics.gauges.backpressureActive}`);

  emit('# HELP hbs_commands_total Total commands processed');
  emit('# TYPE hbs_commands_total counter');
  let grandTotal = 0;
  for (const [type, statusMap] of Object.entries(metrics.counters.commands)) {
    if (type === 'total') continue;
    for (const [labels, count] of Object.entries(statusMap)) {
      grandTotal += count;
      const labelPart = labels ? `{${labels}}` : '';
      emit(`hbs_commands_total{${labels}} ${count}`);
    }
  }
  emit(`hbs_commands_total ${grandTotal}`);

  emit('# HELP hbs_ws_connections_total WebSocket connections established');
  emit('# TYPE hbs_ws_connections_total counter');
  emit(`hbs_ws_connections_total ${metrics.counters.wsConnections}`);

  emit('# HELP hbs_ws_messages_total WebSocket messages received/sent');
  emit('# TYPE hbs_ws_messages_total counter');
  emit(`hbs_ws_messages_total{direction="rx"} ${metrics.counters.wsMessages.rx}`);
  emit(`hbs_ws_messages_total{direction="tx"} ${metrics.counters.wsMessages.tx}`);

  emit('# HELP hbs_idempotency_rejections_total Duplicate commands rejected');
  emit('# TYPE hbs_idempotency_rejections_total counter');
  emit(`hbs_idempotency_rejections_total ${metrics.counters.idempotencyRejections}`);

  emit('# HELP hbs_ws_send_timeouts_total Extension WebSocket sends that timed out (>30s blocked)');
  emit('# TYPE hbs_ws_send_timeouts_total counter');
  emit(`hbs_ws_send_timeouts_total ${metrics.counters.wsSendTimeouts}`);

  const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
  emit('# HELP hbs_command_duration_seconds Command execution duration in seconds');
  emit('# TYPE hbs_command_duration_seconds histogram');
  for (const [cmdType, entries] of Object.entries(metrics.histograms.commandDuration)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const values = entries.map(e => e.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;
    const bucketCounts = new Array(durationBuckets.length + 1).fill(0);
    for (const v of values) {
      const sec = v / 1000;
      for (let i = 0; i < durationBuckets.length; i++) {
        if (sec <= durationBuckets[i]) bucketCounts[i]++;
      }
      bucketCounts[durationBuckets.length]++;
    }
    const bucketLabels = [...durationBuckets.map(b => `le="${b}"`), 'le="+Inf"'];
    for (let i = 0; i <= durationBuckets.length; i++) {
      emit(`hbs_command_duration_seconds_bucket {type="${cmdType}",${bucketLabels[i]}} ${bucketCounts[i]}`);
    }
    emit(`hbs_command_duration_seconds_sum{type="${cmdType}"} ${(sum / 1000).toFixed(4)}`);
    emit(`hbs_command_duration_seconds_count{type="${cmdType}"} ${count}`);
  }

  if (metrics.histograms.htmlBytes.length > 0) {
    emit('# HELP hbs_html_bytes HTML snapshot size in bytes received by proxy');
    emit('# TYPE hbs_html_bytes gauge');
    const latest = metrics.histograms.htmlBytes[metrics.histograms.htmlBytes.length - 1];
    emit(`hbs_html_bytes ${latest.value}`);
  }

  if (metrics.histograms.mutationBufferSize.length > 0) {
    emit('# HELP hbs_mutation_buffer_size Number of mutations in buffer');
    emit('# TYPE hbs_mutation_buffer_size gauge');
    const latest = metrics.histograms.mutationBufferSize[metrics.histograms.mutationBufferSize.length - 1];
    emit(`hbs_mutation_buffer_size ${latest.value}`);
  }

  return lines.join('\n');
}

/**
 * Build a JSON object with current metrics values (for SSE streaming).
 * @param {number} cmdQueueSize
 * @returns {object}
 */
function buildMetricsJson(cmdQueueSize) {
  metricGauge('uptimeSeconds', Math.floor(process.uptime()));
  metricGauge('pendingCommands', cmdQueueSize);
  return {
    uptimeSeconds: metrics.gauges.uptimeSeconds || 0,
    connectedSessions: metrics.gauges.connectedSessions || 0,
    pendingCommands: metrics.gauges.pendingCommands || 0,
    hermesClients: metrics.gauges.hermesClients || 0,
    backpressureActive: metrics.gauges.backpressureActive === 1,
    wsConnections: metrics.counters.wsConnections || 0,
    wsMessages: metrics.counters.wsMessages || { rx: 0, tx: 0 },
    commands: metrics.counters.commands || {},
    idempotencyRejections: metrics.counters.idempotencyRejections || 0,
  };
}

module.exports = { metrics, metricIncr, metricGauge, metricHistogramPush, formatPrometheus, buildMetricsJson };
