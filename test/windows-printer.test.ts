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
