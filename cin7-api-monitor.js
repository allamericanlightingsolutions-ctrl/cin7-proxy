
'use strict';

const MAX_EVENTS = 10000;
const events = [];
let pending = 0;

function record(event) {
  events.push({
    timestamp: new Date().toISOString(),
    ...event
  });

  if (events.length > MAX_EVENTS) {
    events.shift();
  }
}

async function monitorCin7Request(request, metadata = {}) {
  const started = Date.now();
  const source = metadata.source || 'unknown';
  const endpoint = metadata.endpoint || 'unknown';
  const method = metadata.method || 'GET';

  pending++;

  try {
    const response = await request();

    record({
      source,
      endpoint,
      method,
      status: response.status,
      durationMs: Date.now() - started,
      success: response.ok
    });

    return response;
  } catch (error) {
    record({
      source,
      endpoint,
      method,
      status: null,
      durationMs: Date.now() - started,
      success: false,
      error: error.code || 'NETWORK_ERROR'
    });

    throw error;
  } finally {
    pending--;
  }
}

function getApiStats() {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const minuteAgo = now - 60 * 1000;

  const last24h = events.filter(
    event => Date.parse(event.timestamp) >= dayAgo
  );

  const lastMinute = last24h.filter(
    event => Date.parse(event.timestamp) >= minuteAgo
  );

  const bySource = {};

  for (const event of last24h) {
    const source = event.source;

    if (!bySource[source]) {
      bySource[source] = {
        requests: 0,
        errors: 0
      };
    }

    bySource[source].requests++;

    if (!event.success) {
      bySource[source].errors++;
    }
  }

  return {
    requests24h: last24h.length,
    requestsLastMinute: lastMinute.length,
    errors429: last24h.filter(e => e.status === 429).length,
    errors401: last24h.filter(e => e.status === 401).length,
    errors500: last24h.filter(e => e.status >= 500).length,
    pending,
    bySource,
    recentEvents: last24h.slice(-50).reverse()
  };
}

module.exports = {
  monitorCin7Request,
  getApiStats
};
