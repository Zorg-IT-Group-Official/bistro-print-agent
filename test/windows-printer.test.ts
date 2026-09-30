import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { sendRawToWindowsPrinter } from '../src/windows-printer.js';
import { PrinterConfig } from '../src/types.js';

const printer: PrinterConfig = {
  id: 'bar', name: 'Bar Printer', transport: 'windows_printer', host: 'Bar Desk', port: 0,
  paperWidthMm: 58, printableWidthDots: null, renderMode: 'text', codePage: 0,
  cutEnabled: true, beeperEnabled: false, configVersion: 1,
};
const bytes = Buffer.from([0x1b, 0x40, 0x42, 0x61, 0x72]);

test('Windows RAW sender spools bytes and deletes its temp file on success', async () => {
  let filePath = '';
  await sendRawToWindowsPrinter(printer, bytes, 1000, {
    platform: 'win32',
    runPowerShell: async (_name, path) => {
      filePath = path;
      assert.deepEqual(await readFile(path), bytes);
      return { code: 0, output: 'STAGE:opened\nSTAGE:written\n', timedOut: false };
    },
  });
  assert.ok(filePath);
  assert.equal(existsSync(filePath), false);
});

test('Windows RAW sender deletes its temp file on failure and classifies pre-write failure as retryable', async () => {
  let filePath = '';
  await assert.rejects(sendRawToWindowsPrinter(printer, bytes, 1000, {
    platform: 'win32', runPowerShell: async (_name, path) => {
      filePath = path;
      return { code: 10, output: 'WIN32:1801', timedOut: false };
    },
  }), (error: any) => error.delivery === 'retryable_failed');
  assert.ok(filePath);
  assert.equal(existsSync(filePath), false);
});

test('Windows RAW sender classifies failures after write start and timeouts as uncertain', async () => {
  await assert.rejects(sendRawToWindowsPrinter(printer, bytes, 1000, {
    platform: 'win32', runPowerShell: async () => ({ code: 13, output: 'STAGE:write-started', timedOut: false }),
  }), (error: any) => error.delivery === 'uncertain');
  await assert.rejects(sendRawToWindowsPrinter(printer, bytes, 5, {
    platform: 'win32', runPowerShell: async () => ({ code: null, output: 'STAGE:write-started', timedOut: true }),
  }), (error: any) => error.delivery === 'uncertain');
});

test('Windows RAW sender rejects unsafe queue names and non-Windows platforms before spool access', async () => {
  for (const host of ['\\\\server\\printer', 'Bar,Desk', 'Café', 'Bar Desk ']) {
    await assert.rejects(sendRawToWindowsPrinter({ ...printer, host }, bytes, 1000, { platform: 'win32', runPowerShell: async () => ({ code: 0, output: '', timedOut: false }) }), /invalid_windows_printer_name/);
  }
  await assert.rejects(sendRawToWindowsPrinter(printer, bytes, 1000, { platform: 'linux' }), /requires_windows/);
});

// ── Persistent helper (fake PowerShell child; runs on any OS) ─────────────────
import { EventEmitter } from 'node:events';
import { WindowsSpoolHelper } from '../src/windows-printer.js';

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  written: string[] = [];
  killed = false;
  stdin = { write: (chunk: string) => { this.written.push(chunk); this.onRequest(JSON.parse(chunk)); return true; } };
  constructor(private readonly reply: (child: FakeChild, req: { id: string; printer: string; file: string }) => void, ready = true) {
    super();
    if (ready) setImmediate(() => this.out('READY'));
  }
  out(line: string) { this.stdout.emit('data', line + '\n'); }
  onRequest(req: { id: string; printer: string; file: string }) { setImmediate(() => this.reply(this, req)); }
  kill() { this.killed = true; setImmediate(() => this.emit('close', null)); return true; }
}

const ok = (child: FakeChild, req: { id: string }) => {
  for (const stage of ['STAGE:opened', 'STAGE:write-started', 'STAGE:written', 'DONE']) child.out(`${req.id} ${stage}`);
};

test('helper starts PowerShell once and reuses it for later jobs', async () => {
  const children: FakeChild[] = [];
  const helper = new WindowsSpoolHelper(() => { const c = new FakeChild(ok); children.push(c); return c as any; });
  const first = await helper.run('Bar Desk', 'C:\\t\\a.bin', 1000);
  const second = await helper.run('Bar Desk', 'C:\\t\\b.bin', 1000);
  assert.equal(children.length, 1);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.match(first.output, /STAGE:write-started/);
  helper.stop();
});

test('helper result drives the same retry/uncertain classification as before', async () => {
  const failBeforeWrite = new WindowsSpoolHelper(() => new FakeChild((c, r) => c.out(`${r.id} FAIL 11 WIN32:1804`)) as any);
  await assert.rejects(sendRawToWindowsPrinter(printer, bytes, 1000, { platform: 'win32', runPowerShell: (n, p, t) => failBeforeWrite.run(n, p, t) }),
    (error: any) => error.delivery === 'retryable_failed' && /WIN32:1804/.test(error.message));
  failBeforeWrite.stop();
  const failAfterWrite = new WindowsSpoolHelper(() => new FakeChild((c, r) => { c.out(`${r.id} STAGE:opened`); c.out(`${r.id} STAGE:write-started`); c.out(`${r.id} FAIL 13 WIN32:5`); }) as any);
  await assert.rejects(sendRawToWindowsPrinter(printer, bytes, 1000, { platform: 'win32', runPowerShell: (n, p, t) => failAfterWrite.run(n, p, t) }),
    (error: any) => error.delivery === 'uncertain');
  failAfterWrite.stop();
});

test('a timed-out job kills the helper, is reported as a timeout, and the next job gets a fresh helper', async () => {
  const children: FakeChild[] = [];
  let hang = true;
  const helper = new WindowsSpoolHelper(() => {
    const c = new FakeChild((child, req) => { if (hang) { child.out(`${req.id} STAGE:write-started`); return; } ok(child, req); });
    children.push(c); return c as any;
  });
  const timedOut = await helper.run('Bar Desk', 'C:\\t\\a.bin', 50);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.output, /STAGE:write-started/); // => uncertain, never auto-reprinted
  assert.equal(children[0].killed, true);
  hang = false;
  const next = await helper.run('Bar Desk', 'C:\\t\\b.bin', 1000);
  assert.equal(next.code, 0);
  assert.equal(children.length, 2);
  helper.stop();
});

test('a late close from a replaced helper never finishes the next job', async () => {
  const children: FakeChild[] = [];
  const helper = new WindowsSpoolHelper(() => {
    const index = children.length;
    const c = new FakeChild((child, req) => {
      if (index === 0) return; // first helper hangs
      // Second helper: before answering, the old helper finally reports its exit.
      children[0].emit('close', 1);
      setTimeout(() => ok(child, req), 10);
    });
    children.push(c); return c as any;
  });
  const first = await helper.run('Bar Desk', 'C:\\t\\a.bin', 30);
  assert.equal(first.timedOut, true);
  const second = await helper.run('Bar Desk', 'C:\\t\\b.bin', 1000);
  assert.equal(second.code, 0, 'stale close must not fail the new job');
  helper.stop();
});

test('helper that dies mid-job reports a failure (never success) and is replaced', async () => {
  const children: FakeChild[] = [];
  const helper = new WindowsSpoolHelper(() => {
    const c = new FakeChild((child, req) => {
      if (children.length === 1) { child.out(`${req.id} STAGE:opened`); child.emit('close', 0); return; }
      ok(child, req);
    });
    children.push(c); return c as any;
  });
  const died = await helper.run('Bar Desk', 'C:\\t\\a.bin', 1000);
  assert.notEqual(died.code, 0);
  assert.doesNotMatch(died.output, /write-started/); // => retryable, safe
  const next = await helper.run('Bar Desk', 'C:\\t\\b.bin', 1000);
  assert.equal(next.code, 0);
  helper.stop();
});

test('helper that never becomes ready fails the job as retryable without writing anything', async () => {
  const child = new FakeChild(ok, false);
  const helper = new WindowsSpoolHelper(() => child as any);
  const result = await helper.run('Bar Desk', 'C:\\t\\a.bin', 30);
  assert.notEqual(result.code, 0);
  assert.equal(child.written.length, 0);
  assert.doesNotMatch(result.output, /write-started/);
});

test('helper requests are pure ASCII JSON even for non-ASCII temp paths', async () => {
  let child: FakeChild | null = null;
  const helper = new WindowsSpoolHelper(() => { child = new FakeChild(ok); return child as any; });
  await helper.run('Bar Desk', 'C:\\Users\\Jösé\\AppData\\Local\\Temp\\job.bin', 1000);
  const line = child!.written[0];
  assert.match(line, /^[\x20-\x7e]*\n$/);
  assert.equal(JSON.parse(line).file, 'C:\\Users\\Jösé\\AppData\\Local\\Temp\\job.bin');
  helper.stop();
});

test('warm-up is a no-op off Windows', async () => {
  const { warmUpWindowsPrinter } = await import('../src/windows-printer.js');
  assert.equal(await warmUpWindowsPrinter(1000, 'linux'), false);
});
