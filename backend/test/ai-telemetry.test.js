process.env.STORE_BACKEND = 'memory';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('telemetry records failures and usage without logging private inputs', async () => {
  const { trackAiRequest } = require('../src/services/aiTelemetry');
  const rows = []; const write = async row => rows.push(row);
  const value = await trackAiRequest({ model: 'unknown-model', capability: 'coach', prompt: 'PRIVATE CV' },
    async note => { note({ usage: { promptTokenCount: 10, candidatesTokenCount: 4 }, tools: ['list_sessions'] }); return 'OK'; }, { write });
  assert.equal(value, 'OK'); assert.equal(rows[0].tokens_in, 10); assert.equal(rows[0].tokens_out, 4);
  assert.equal(rows[0].cost_usd, null); assert.deepEqual(rows[0].tools, ['list_sessions']);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE CV/);
  await assert.rejects(trackAiRequest({ capability: 'coach' }, async () => { throw Object.assign(new Error('secret key'), { name: 'AbortError' }); }, { write }));
  assert.equal(rows[1].status, 'timeout'); assert.doesNotMatch(JSON.stringify(rows), /secret key/);
});

test('health uses cached failure state without making paid requests', () => {
  const health = require('../src/services/aiHealth');
  assert.equal(health.status().state, 'unconfigured', 'nothing is configured by default');
  process.env.TUTOR_LLM_PROVIDER = 'local';
  assert.equal(health.status().state, 'unknown');
  health.recordFailure({ upstreamStatus: 429 });
  assert.equal(health.status().available, false); assert.equal(health.status().reason, 'quota');
  health.recordSuccess(); assert.equal(health.status().available, true);
  delete process.env.TUTOR_LLM_PROVIDER;
});

