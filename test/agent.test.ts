import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import net from 'node:net';
import { PrintLedger } from '../src/ledger.js';
import { renderKot, rendererInternals } from '../src/renderer.js';
import { sendRaw } from '../src/tcp-printer.js';
import { PrintAgentRunner } from '../src/agent.js';
import { PrintApi } from '../src/api.js';
import { AgentConfig, loadConfig } from '../src/config.js';
import { ClaimedJob } from '../src/types.js';

const printer = { id: 'printer-1', name: 'Kitchen Printer', host: '127.0.0.1', port: 9100, paperWidthMm: 58, printableWidthDots: null, renderMode: 'text', codePage: 0, cutEnabled: true, beeperEnabled: false, configVersion: 1 };
const payload: ClaimedJob['payload'] = {
  schemaVersion: 1, kind: 'new_kot', station: { id: 'station-1', name: 'Main Kitchen' }, kotRevision: 0,
  order: { id: 'order-1', orderNumber: 'ORD-20260924-0001', source: 'dine_in', tableNumber: 'T-01', customerName: 'Walk-in Customer', cashierName: 'Sam', createdAt: '2026-09-24T12:45:00.000Z', note: null },
  items: [{ orderItemId: 'oi-1', itemName: 'Pancake Stack with Extra Syrup', variantName: null, quantity: 2, modifiers: ['Extra syrup'], note: 'No ice' }],
  branch: { name: 'Bistro' }, printing: { createdAt: '2026-09-24T12:45:01.000Z', originalJobId: null, originalOrderNumber: null },
};

test('renderer wraps item names, prints right-aligned QTY, notes at bottom and cut command only when configured', () => {
  const bytes = renderKot({ payload, printer });
  const text = bytes.toString('ascii');
  assert.match(text, /Item Name\s+QTY/);
  assert.match(text, /Pancake Stack with Extra/);
  assert.match(text, /Total Item: 2/);
  assert.ok(text.indexOf('Notes:') > text.indexOf('Total Item: 2'));
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0x00])));
  const noCut = renderKot({ payload, printer: { ...printer, cutEnabled: false } });
  assert.equal(noCut.includes(Buffer.from([0x1d, 0x56, 0x00])), false);
});

test('order update renderer clearly distinguishes updates and prints station deltas plus current context', () => {
  const update = structuredClone(payload);
  update.kind = 'order_update';
  update.kotRevision = 7;
  update.changes = [
    { orderItemId: 'a', itemName: 'Chicken Wings', variantName: null, modifiers: [], note: null, changeType: 'added', previousQuantity: 0, newQuantity: 2, quantityDelta: 2, reason: null },
    { orderItemId: 'b', itemName: 'Chicken Burger', variantName: null, modifiers: [], note: null, changeType: 'increased', previousQuantity: 1, newQuantity: 3, quantityDelta: 2, reason: null },
    { orderItemId: 'c', itemName: 'Spring Rolls', variantName: null, modifiers: [], note: null, changeType: 'reduced', previousQuantity: 3, newQuantity: 1, quantityDelta: 2, reason: null },
    { orderItemId: 'd', itemName: 'Beef Burger', variantName: null, modifiers: [], note: null, changeType: 'cancelled', previousQuantity: 1, newQuantity: 0, quantityDelta: 1, reason: 'Customer requested cancellation' },
  ];
  update.currentItems = [{ orderItemId: 'b', itemName: 'Chicken Burger', variantName: null, quantity: 3, modifiers: [], note: null }];
  const text = renderKot({ payload: update, printer }).toString('ascii');
  assert.match(text, /ORDER UPDATE/);
  assert.match(text, /NOT A NEW ORDER/);
  assert.doesNotMatch(text, /NEW ORDER TOKEN/);
  assert.match(text, /ADDED[\s\S]*2x Chicken Wings/);
  assert.match(text, /QTY INCREASED[\s\S]*Previous: 1[\s\S]*New: 3[\s\S]*Add: 2/);
  assert.match(text, /QTY REDUCED[\s\S]*Previous: 3[\s\S]*New: 1[\s\S]*Remove: 2/);
  assert.match(text, /CANCELLED[\s\S]*1x Beef Burger[\s\S]*Reason: Customer requested[\s\S]*cancellation/);
  assert.match(text, /CURRENT STATION ORDER[\s\S]*3x Chicken Burger/);
});

test('reprinted update payload still renders as an update with a reprint label', () => {
  const update = structuredClone(payload);
  update.kind = 'reprint';
  update.sourceKind = 'order_update';
  update.changes = [{ orderItemId: 'a', itemName: 'Water', variantName: null, modifiers: [], note: null, changeType: 'added', previousQuantity: 0, newQuantity: 1, quantityDelta: 1, reason: null }];
  update.currentItems = [];
  const text = renderKot({ payload: update, printer }).toString('ascii');
  assert.match(text, /ORDER UPDATE[\s\S]*NOT A NEW ORDER[\s\S]*REPRINT[\s\S]*ADDED[\s\S]*1x Water/);
});

test('renderer rejects non-ASCII instead of silently corrupting names', () => {
  const localized = structuredClone(payload); localized.items[0].itemName = 'ভাত';
  assert.throws(() => renderKot({ payload: localized, printer }), /unsupported_character/);
});

test('wrap handles long unbroken text within the printable column width', () => {
  assert.deepEqual(rendererInternals.wrap('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 10), ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123', '456789']);
});

test('SQLite ledger prevents duplicates, detects changed immutable payloads and preserves restart state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bistro-agent-'));
  const path = join(directory, 'ledger.sqlite');
  try {
    const ledger = new PrintLedger(path);
    assert.equal(ledger.recordClaim('job-1', payload, printer), 'new');
    ledger.setStatus('job-1', 'sent');
    assert.equal(ledger.recordClaim('job-1', payload, printer), 'duplicate');
    assert.equal(ledger.recordClaim('job-1', { ...payload, kind: 'reprint' }, printer), 'payload_mismatch');
    ledger.close();
    const restarted = new PrintLedger(path);
    assert.equal(restarted.get('job-1')?.status, 'sent');
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('TCP transport writes ESC/POS bytes to a local mock listener', async () => {
  let received = Buffer.alloc(0);
  let resolveData!: () => void;
  const dataReceived = new Promise<void>((resolve) => { resolveData = resolve; });
  const server = net.createServer((socket) => socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); resolveData(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await sendRaw({ ...printer, port: address.port }, Buffer.from([0x1b, 0x40, 0x48, 0x69]), 1000);
    await dataReceived;
    assert.deepEqual(received, Buffer.from([0x1b, 0x40, 0x48, 0x69]));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('TCP transport refuses public or hostname targets', async () => {
  await assert.rejects(sendRaw({ ...printer, host: '8.8.8.8' }, Buffer.from('x'), 100), /invalid_printer_target/);
  await assert.rejects(sendRaw({ ...printer, host: 'example.com' }, Buffer.from('x'), 100), /invalid_printer_target/);
});

test('agent persists sent before backend acknowledgement and never resends the same job after restart state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bistro-runner-'));
  const originalFetch = globalThis.fetch;
  let sends = 0;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: { accepted: true, id: 'job-1', status: 'sent' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const config: AgentConfig = { apiBaseUrl: 'https://example.test', credential: 'x'.repeat(48), databasePath: join(directory, 'agent.sqlite'), pollMs: 10, heartbeatMs: 1000, connectTimeoutMs: 100 };
    const runner = new PrintAgentRunner(config, config.databasePath, async () => { sends++; });
    const job: ClaimedJob = { id: 'job-1', status: 'claimed', payload, printer };
    await runner.process(job);
    await runner.process(job);
    assert.equal(sends, 1);
    runner.close();
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent routes Windows jobs by transport while missing transport keeps using TCP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bistro-transport-routing-'));
  const originalFetch = globalThis.fetch;
  const tcpJobs: string[] = [];
  const windowsJobs: string[] = [];
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: { accepted: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const config: AgentConfig = { apiBaseUrl: 'https://example.test', credential: 'x'.repeat(48), databasePath: join(directory, 'agent.sqlite'), pollMs: 10, heartbeatMs: 1000, connectTimeoutMs: 100 };
    const runner = new PrintAgentRunner(config, config.databasePath,
      async (target) => { tcpJobs.push(target.id); }, async (target) => { windowsJobs.push(target.id); });
    await runner.process({ id: 'legacy-tcp', status: 'claimed', payload, printer });
    await runner.process({ id: 'usb-bar', status: 'claimed', payload, printer: { ...printer, transport: 'windows_printer' } });
    await runner.process({ id: 'unknown', status: 'claimed', payload, printer: { ...printer, transport: 'future_transport' } as any });
    assert.deepEqual(tcpJobs, ['printer-1']);
    assert.deepEqual(windowsJobs, ['printer-1']);
    runner.close();
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('claim advertises Windows queues only on Windows', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  try {
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const config: AgentConfig = { apiBaseUrl: 'https://example.test', credential: 'x'.repeat(48), databasePath: ':memory:', pollMs: 10, heartbeatMs: 1000, connectTimeoutMs: 100 };
    await new PrintApi(config, 'win32').claim();
    await new PrintApi(config, 'linux').claim();
    assert.deepEqual(bodies, [{ transports: ['escpos_tcp', 'windows_printer'] }, { transports: ['escpos_tcp'] }]);
  } finally { globalThis.fetch = originalFetch; }
});

test('unknown job kind is safely failed without sending any TCP bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bistro-unknown-kind-'));
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  let sends = 0;
  try {
    globalThis.fetch = async (input, init) => {
      paths.push(`${new URL(String(input)).pathname}:${String(JSON.parse(String(init?.body ?? '{}')).status ?? '')}`);
      return new Response(JSON.stringify({ success: true, data: { accepted: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const config: AgentConfig = { apiBaseUrl: 'https://example.test', credential: 'x'.repeat(48), databasePath: join(directory, 'agent.sqlite'), pollMs: 10, heartbeatMs: 1000, connectTimeoutMs: 100 };
    const runner = new PrintAgentRunner(config, config.databasePath, async () => { sends++; });
    await runner.process({ id: 'unknown-kind', status: 'claimed', payload: { ...payload, kind: 'future_kind' } as any, printer });
    assert.equal(sends, 0);
    assert.equal(paths.some((path) => path.includes('/sending:')), false);
    assert.ok(paths.some((path) => path.endsWith('/result:failed')));
    assert.equal(paths.some((path) => path.endsWith('/result:uncertain')), false);
    runner.close();
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('malformed known-kind payload is safely failed without sending any TCP bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bistro-malformed-payload-'));
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  let sends = 0;
  try {
    globalThis.fetch = async (input, init) => {
      paths.push(`${new URL(String(input)).pathname}:${String(JSON.parse(String(init?.body ?? '{}')).status ?? '')}`);
      return new Response(JSON.stringify({ success: true, data: { accepted: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const config: AgentConfig = { apiBaseUrl: 'https://example.test', credential: 'x'.repeat(48), databasePath: join(directory, 'agent.sqlite'), pollMs: 10, heartbeatMs: 1000, connectTimeoutMs: 100 };
    const runner = new PrintAgentRunner(config, config.databasePath, async () => { sends++; });
    await runner.process({ id: 'malformed-payload', status: 'claimed', payload: { ...payload, items: null } as any, printer });
    assert.equal(sends, 0);
    assert.equal(paths.some((path) => path.includes('/sending:')), false);
    assert.ok(paths.some((path) => path.endsWith('/result:failed')));
    runner.close();
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('malformed order-update quantities are failed before sending any TCP bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bistro-malformed-update-quantities-'));
  const originalFetch = globalThis.fetch;
  const statuses: string[] = [];
  let sends = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/result')) statuses.push(String(JSON.parse(String(init?.body ?? '{}')).status));
      return new Response(JSON.stringify({ success: true, data: { accepted: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const config: AgentConfig = { apiBaseUrl: 'https://example.test', credential: 'x'.repeat(48), databasePath: join(directory, 'agent.sqlite'), pollMs: 10, heartbeatMs: 1000, connectTimeoutMs: 100 };
    const runner = new PrintAgentRunner(config, config.databasePath, async () => { sends++; });
    const validUpdate = structuredClone(payload);
    validUpdate.kind = 'order_update';
    validUpdate.changes = [{ orderItemId: 'item-1', itemName: 'Water', variantName: null, modifiers: [], note: null,
      changeType: 'increased', previousQuantity: 1, newQuantity: 2, quantityDelta: 1, reason: null }];
    const invalidChanges = [
      { ...validUpdate.changes[0], previousQuantity: undefined },
      { ...validUpdate.changes[0], newQuantity: Number.NaN },
      { ...validUpdate.changes[0], quantityDelta: 0 },
      { ...validUpdate.changes[0], changeType: 'reduced' as const, previousQuantity: 1, newQuantity: 0, quantityDelta: 1 },
    ];
    for (let index = 0; index < invalidChanges.length; index++) {
      await runner.process({ id: `malformed-update-${index}`, status: 'claimed', payload: { ...validUpdate, changes: [invalidChanges[index]] } as any, printer });
    }
    assert.equal(sends, 0);
    assert.equal(statuses.length, invalidChanges.length);
    assert.ok(statuses.every((status) => status === 'failed'));
    runner.close();
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('pre-send render failure remains failed when the backend acknowledgement is retried', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bistro-render-failure-'));
  const originalFetch = globalThis.fetch;
  const statuses: string[] = [];
  let resultAttempts = 0;
  let sends = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/result')) {
        const status = String(JSON.parse(String(init?.body ?? '{}')).status);
        statuses.push(status);
        resultAttempts++;
        if (resultAttempts === 1) throw new Error('temporary acknowledgement outage');
      }
      return new Response(JSON.stringify({ success: true, data: { accepted: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const config: AgentConfig = { apiBaseUrl: 'https://example.test', credential: 'x'.repeat(48), databasePath: join(directory, 'agent.sqlite'), pollMs: 10, heartbeatMs: 1000, connectTimeoutMs: 100 };
    const runner = new PrintAgentRunner(config, config.databasePath, async () => { sends++; });
    const localized = structuredClone(payload); localized.items[0].itemName = 'ভাত';
    const job: ClaimedJob = { id: 'render-failure', status: 'claimed', payload: localized, printer };
    await runner.process(job);
    await runner.process(job);
    assert.equal(sends, 0);
    assert.deepEqual(statuses, ['failed', 'failed']);
    assert.equal(statuses.includes('uncertain'), false);
    runner.close();
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('plaintext agent credential requires explicit development-only opt in', () => {
  const env = { BISTRO_API_URL: 'https://api.example', BISTRO_AGENT_CREDENTIAL: 'x'.repeat(48) } as NodeJS.ProcessEnv;
  assert.throws(() => loadConfig(env), /Plaintext agent credentials are disabled/);
  assert.equal(loadConfig({ ...env, BISTRO_AGENT_ALLOW_PLAINTEXT_CREDENTIAL: 'true' }).credential, env.BISTRO_AGENT_CREDENTIAL);
});
