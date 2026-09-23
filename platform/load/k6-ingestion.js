import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const dsn = __ENV.MONITOR_DSN;
const origin = __ENV.MONITOR_ORIGIN || 'http://localhost:8080';
const appName = __ENV.MONITOR_APP_NAME || 'load-test';

export const options = {
  scenarios: {
    sustained_500_events_per_second: {
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 30,
      maxVUs: 100,
      exec: 'sendBatch',
    },
    peak_2000_events_per_second: {
      executor: 'constant-arrival-rate',
      startTime: '10m',
      rate: 100,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 100,
      maxVUs: 250,
      exec: 'sendBatch',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function sendBatch() {
  if (!dsn) throw new Error('MONITOR_DSN is required');
  const now = Date.now();
  const sessionId = `load-session-${exec.vu.idInTest}`;
  const events = Array.from({ length: 20 }, (_, index) => {
    const suffix = `${exec.scenario.iterationInTest}-${index}`;
    return {
      protocolVersion: '3.0',
      eventId: `load-event-${suffix}`,
      type: 'performance',
      name: 'LCP',
      occurredAt: now,
      app: { name: appName, version: 'load', environment: 'load-test' },
      context: {
        sessionId,
        viewId: `load-view-${suffix}`,
        routeName: 'load-test',
        url: `${origin}/load-test`,
        runtime: { sdk: { name: 'k6', version: '1.0.0' } },
      },
      correlation: {},
      payload: {
        type: 'performance', name: 'LCP', sampleId: `load-sample-${suffix}`,
        sequence: 0, state: 'final', value: 1800 + (index % 10) * 100,
        unit: 'ms', kind: 'core-web-vital', source: 'web-vitals', delta: 1800,
        clientRating: 'good', navigationType: 'navigate', navigationId: 0,
      },
    };
  });
  const response = http.post(dsn, JSON.stringify({
    protocolVersion: '3.0', sentAt: now, sdk: { name: 'k6', version: '1.0.0' }, events,
  }), { headers: { 'content-type': 'application/json', origin } });
  check(response, { 'ingestion accepted': (value) => value.status === 202 });
}

