'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const modules = new Map([
  ['https://aalscatalog.com', 'bbw'],
  ['https://www.aalscatalog.com', 'bbw'],
  ['https://aals-catalog.netlify.app', 'bbw'],
  ['https://aals-tapestry.netlify.app', 'tapestry'],
  ['https://aalsoperations.com', 'operations'],
  ['https://www.aalsoperations.com', 'operations'],
  ['https://aals-operations.netlify.app', 'operations'],
  ['https://aals-warehouse-control.netlify.app', 'warehouse'],
]);

const operationsRoutes = new Set([
  '/api/sync-cin7-orders-to-operations',
  '/api/sync-cin7-purchase-orders-to-operations',
  '/api/import-cin7-order-by-ref-to-operations',
  '/api/audit-cin7-order-numbers',
  '/api/recheck-workflow-inventory',
  '/api/drawer-slides-work-orders',
  '/api/bbw-invoice-statement',
]);

function createCin7Usage({ enabled, databaseUrl, serviceKey, alertRecipients, alertAt, fetch, sendEmail, logger = console }) {
  const context = new AsyncLocalStorage();
  const connection = 'platforms-api-2';
  const pending = [];
  let flushing = false;
  let dropped = 0;
  const active = Boolean(enabled && databaseUrl && serviceKey);
  if (enabled && !active) logger.warn('Cin7 usage requires Supabase server configuration.');
  const threshold = Number.isSafeInteger(alertAt) && alertAt > 0 && alertAt < 5000 ? alertAt : 4000;
  const recipients = [...new Set(String(alertRecipients || '').split(',').map(x => x.trim()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];

  function middleware(req, _res, next) {
    if (!active) return next();
    const module = operationsRoutes.has(req.path) ? 'operations' : modules.get(req.get('origin')) || 'unattributed';
    return context.run(module, next);
  }

  async function attempt(request, endpoint, method, number) {
    if (!active) return request();
    const started = Date.now();
    let status = null;
    try {
      const response = await request();
      status = response.status;
      return response;
    } finally {
      if (pending.length >= 5000) {
        dropped++;
      } else {
        pending.push({
          id: randomUUID(),
          occurred_at: new Date(started).toISOString(),
          connection,
          module: context.getStore() || 'unattributed',
          endpoint: /^[a-zA-Z0-9_-]{1,40}$/.test(endpoint) ? endpoint.toLowerCase() : 'other',
          method: String(method || 'GET').toUpperCase(),
          http_status: status,
          attempt_number: number,
        });
      }
    }
  }

  async function database(path, body, prefer = 'return=minimal') {
    const res = await fetch(databaseUrl.replace(/\/$/, '') + '/rest/v1/' + path, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: prefer,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('Telemetry storage HTTP ' + res.status);
    return res;
  }

  async function summary() {
    return (await database('rpc/cin7_usage_summary', { p_connection: connection })).json();
  }

  async function notifyIfNeeded() {
    if (!recipients.length) return;
    const claim = await (await database('rpc/cin7_usage_claim_alert', {
      p_connection: connection,
      p_threshold: threshold,
    })).json();
    if (!claim) return;
    const moduleLines = claim.modules.map(row => row.module + ': ' + row.estimated_calls);
    await sendEmail({
      to: recipients,
      subject: 'AALS Cin7 usage alert: ' + claim.estimated_calls + ' calls',
      html: '<p>Estimated calls in the last 24 hours: <b>' + claim.estimated_calls +
        ' / 5000</b> (' + connection + ').</p><p>HTTP 429 responses: ' + claim.rate_limited +
        '.</p><ul>' + moduleLines.map(line => '<li>' + line + '</li>').join('') + '</ul>',
    });
    await database('rpc/cin7_usage_mark_alert_sent', { p_id: claim.id });
  }

  async function flush() {
    if (!active || flushing) return;
    flushing = true;
    try {
      if (pending.length) {
        const batch = pending.slice(0, 200);
        await database('cin7_usage_events?on_conflict=id', batch, 'resolution=ignore-duplicates,return=minimal');
        pending.splice(0, batch.length);
      }
      if (dropped) {
        logger.warn('Cin7 usage events dropped while telemetry storage was unavailable:', dropped);
        dropped = 0;
      }
      if (!pending.length) await notifyIfNeeded();
    } catch (error) {
      logger.warn('Cin7 usage telemetry unavailable:', error.name);
    } finally {
      flushing = false;
    }
  }

  return { active, middleware, attempt, summary, flush };
}

module.exports = { createCin7Usage };
