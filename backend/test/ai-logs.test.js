process.env.STORE_BACKEND = 'memory';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const context = require('../src/context/requestContext');
const telemetry = require('../src/services/aiTelemetry');

test('shared telemetry retains provider, operation, and legacy metadata', async () => {
  const rows = [];
  const row = await telemetry.logAiRequest({ provider: 'gemini', operation: 'chat', model: 'm',
    prompt_version: 'long-v1', status: 'ok' }, { write: async row => rows.push(row) });
  assert.equal(row.provider, 'gemini');
  assert.equal(row.operation, 'chat');
  assert.equal(rows.length, 1);
});

test('Long adapter preserves context and maps legacy fields without duplicate provider logs', async () => {
  const legacy = require('../src/services/aiRequestLogService');
  const rows = []; const write = async row => rows.push(row);
  await context.run({ requestId: 'request-1', promptName: 'knowledge-coach' }, () =>
    legacy.runForUser('alice', async () => {
      await telemetry.trackAiRequest({ provider: 'gemini', operation: 'chat', model: 'm' },
        async note => note({ usage: { promptTokenCount: 3, candidatesTokenCount: 2 } }), { write });
      await legacy.logAiRequest({ provider: 'gemini', model: 'm', operation: 'chat',
        durationMs: 25, promptVersion: 'long-v1', status: 'ok' }, { write });
    }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, 'request-1'); assert.equal(rows[0].user_id, null);
  assert.equal(rows[0].legacy_user_id, 'alice');
  assert.equal(rows[0].prompt_name, 'knowledge-coach');
  await legacy.runForUser('bob', () => legacy.logAiRequest({ provider: 'gemini', model: 'm',
    operation: 'embed_query', promptVersion: 'long-v1', durationMs: 25, status: 'cancelled' }, { write }));
  assert.equal(rows.length, 2); assert.equal(rows[1].capability, 'embed');
  assert.equal(rows[1].prompt_version, 'long-v1'); assert.equal(rows[1].latency_ms, 25);
  assert.equal(rows[1].status, 'error'); assert.equal(rows[1].error_code, 'cancelled');
  assert.ok(rows[1].request_id);
});

test('compatibility summary is suppressed in the existing HTTP context without runForUser', async () => {
  const legacy = require('../src/services/aiRequestLogService');
  const rows = []; const write = async row => rows.push(row);
  await context.run({ requestId: 'http-request', userId: 'alice' }, async () => {
    await telemetry.trackAiRequest({ provider: 'gemini', operation: 'chat' }, async () => 'ok', { write });
    await legacy.logAiRequest({ provider: 'gemini', operation: 'chat', durationMs: 2, status: 'ok' }, { write });
  });
  assert.equal(rows.length, 1);
});

test('overlapping calls each suppress their own legacy summary', async () => {
  const legacy = require('../src/services/aiRequestLogService');
  const rows = []; const write = async row => rows.push(row);
  await legacy.runForUser('alice', async () => {
    await Promise.all([1, 2].map(() => telemetry.trackAiRequest({ provider: 'gemini', operation: 'chat' }, async () => 'ok', { write })));
    for (let i = 0; i < 2; i++) await legacy.logAiRequest({ provider: 'gemini', operation: 'chat', status: 'ok', durationMs: 1 }, { write });
  });
  assert.equal(rows.length, 2);
});

test('compatibility export and erase include owned legacy rows and never other users', async t => {
  const supabase = require('../src/db/supabase');
  const owner = '00000000-0000-4000-8000-000000000001';
  const deleted = [];
  const records = [
    { id: '1', user_id: owner, legacy_user_id: owner, prompt_version: 'long-v1', latency_ms: 12, created_at: '2026-10-24', status: 'ok' },
    { id: '2', user_id: null, legacy_user_id: owner, latency_ms: 14, created_at: '2026-10-25', status: 'error', error_code: 'cancelled' },
    { id: '3', user_id: 'bob', legacy_user_id: 'bob' },
  ];
  t.mock.method(supabase, 'memoryPreview', () => false);
  t.mock.method(supabase, 'adminClient', () => ({ from: table => {
    assert.equal(table, 'ai_logs');
    return {
      select: () => ({ eq: (key, value) => { const query = { order: () => query, range: async (start, end) =>
        ({ data: records.filter(r => r[key] === value).slice(start, end + 1) }) }; return query; } }),
      delete: () => ({ eq: async (key, value) => { deleted.push([key, value]); return {}; } }),
    };
  } }));
  delete require.cache[require.resolve('../src/services/aiRequestLogService')];
  const legacy = require('../src/services/aiRequestLogService');
  const rows = await legacy.listForUser(owner);
  assert.equal(rows.length, 2); assert.equal(rows[0].promptVersion, 'long-v1');
  assert.equal(rows[1].durationMs, 14); assert.equal(rows[1].status, 'cancelled');
  await legacy.deleteForUser(owner);
  assert.deepEqual(deleted, [['user_id', owner], ['legacy_user_id', owner]]);
});

test('legacy text owners never reach a UUID filter', async t => {
  const supabase = require('../src/db/supabase');
  const queried = [];
  t.mock.method(supabase, 'memoryPreview', () => false);
  const query = { order: () => query, range: async () => ({ data: [] }) };
  const eq = (key, value) => { queried.push([key, value]); assert.notEqual(key, 'user_id'); return query; };
  t.mock.method(supabase, 'adminClient', () => ({ from: () => ({ select: () => ({ eq }), delete: () => ({
    eq: async (key, value) => { eq(key, value); return {}; },
  }) }) }));
  delete require.cache[require.resolve('../src/services/aiRequestLogService')];
  const legacy = require('../src/services/aiRequestLogService');
  await legacy.listForUser('old-text-owner'); await legacy.deleteForUser('old-text-owner');
  assert.deepEqual(queried, [['legacy_user_id', 'old-text-owner'], ['legacy_user_id', 'old-text-owner']]);
});

