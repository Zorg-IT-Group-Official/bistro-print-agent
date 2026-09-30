import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { PrinterConfig } from './types.js';

/**
 * One long-lived PowerShell process compiles the winspool P/Invoke type once
 * (Add-Type takes seconds on a laptop), then spools one RAW job per stdin line:
 *   request : {"id":"<job>","printer":"<queue name>","file":"<temp path>"}   (ASCII-only JSON)
 *   replies : "<id> STAGE:opened" / "<id> STAGE:write-started" / "<id> STAGE:written",
 *             then "<id> DONE" or "<id> FAIL <code> WIN32:<n>"
 * The queue name and path arrive as JSON data, never as script text.
 */
const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public static class BistroRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOC_INFO_1 { public string pDocName; public string pOutputFile; public string pDatatype; }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr handle, int level, [In] DOC_INFO_1 docInfo);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
}
'@
Add-Type -TypeDefinition $source
function Say([string]$text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
Say 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $id = [string]$req.id
  $handle = [IntPtr]::Zero; $docStarted = $false; $pageStarted = $false; $code = 0; $err = 0
  try {
    if (-not [BistroRawPrinter]::OpenPrinter([string]$req.printer, [ref]$handle, [IntPtr]::Zero)) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $code = 10; throw 'open' }
    Say "$id STAGE:opened"
    $doc = New-Object BistroRawPrinter+DOC_INFO_1
    $doc.pDocName = 'Bistro OS token'; $doc.pOutputFile = $null; $doc.pDatatype = 'RAW'
    if ([BistroRawPrinter]::StartDocPrinter($handle, 1, $doc) -eq 0) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $code = 11; throw 'doc' }
    $docStarted = $true
    if (-not [BistroRawPrinter]::StartPagePrinter($handle)) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $code = 12; throw 'page' }
    $pageStarted = $true
    $bytes = [IO.File]::ReadAllBytes([string]$req.file)
    Say "$id STAGE:write-started"
    [int]$written = 0
    if (-not [BistroRawPrinter]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written) -or $written -ne $bytes.Length) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $code = 13; throw 'write' }
    Say "$id STAGE:written"
    if (-not [BistroRawPrinter]::EndPagePrinter($handle)) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $code = 14; throw 'endpage' }
    $pageStarted = $false
    if (-not [BistroRawPrinter]::EndDocPrinter($handle)) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $code = 15; throw 'enddoc' }
    $docStarted = $false
    Say "$id DONE"
  } catch {
    if ($code -eq 0) { $code = 99 }
    Say "$id FAIL $code WIN32:$err"
  } finally {
    if ($pageStarted) { [void][BistroRawPrinter]::EndPagePrinter($handle) }
    if ($docStarted) { [void][BistroRawPrinter]::EndDocPrinter($handle) }
    if ($handle -ne [IntPtr]::Zero) { [void][BistroRawPrinter]::ClosePrinter($handle) }
  }
}
`;

/** Fallback: the original one-process-per-job sender (0.2.0), used only if the helper cannot start. */
const ONE_SHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public static class BistroRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOC_INFO_1 { public string pDocName; public string pOutputFile; public string pDatatype; }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr handle, int level, [In] DOC_INFO_1 docInfo);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
}
'@
Add-Type -TypeDefinition $source
$handle = [IntPtr]::Zero
$docStarted = $false
$pageStarted = $false
try {
  if (-not [BistroRawPrinter]::OpenPrinter($env:BISTRO_PRINTER_NAME, [ref]$handle, [IntPtr]::Zero)) { $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); [Console]::Error.WriteLine("WIN32:$e"); exit 10 }
  [Console]::Out.WriteLine('STAGE:opened'); [Console]::Out.Flush()
  $doc = New-Object BistroRawPrinter+DOC_INFO_1
  $doc.pDocName = 'Bistro OS token'; $doc.pOutputFile = $null; $doc.pDatatype = 'RAW'
  if ([BistroRawPrinter]::StartDocPrinter($handle, 1, $doc) -eq 0) { $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); [Console]::Error.WriteLine("WIN32:$e"); exit 11 }
  $docStarted = $true
  if (-not [BistroRawPrinter]::StartPagePrinter($handle)) { $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); [Console]::Error.WriteLine("WIN32:$e"); exit 12 }
  $pageStarted = $true
  $bytes = [IO.File]::ReadAllBytes($env:BISTRO_PRINT_FILE)
  [Console]::Out.WriteLine('STAGE:write-started'); [Console]::Out.Flush()
  [int]$written = 0
  if (-not [BistroRawPrinter]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written) -or $written -ne $bytes.Length) { $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); [Console]::Error.WriteLine("WIN32:$e"); exit 13 }
  [Console]::Out.WriteLine('STAGE:written'); [Console]::Out.Flush()
  if (-not [BistroRawPrinter]::EndPagePrinter($handle)) { $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); [Console]::Error.WriteLine("WIN32:$e"); exit 14 }
  $pageStarted = $false
  if (-not [BistroRawPrinter]::EndDocPrinter($handle)) { $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); [Console]::Error.WriteLine("WIN32:$e"); exit 15 }
  $docStarted = $false
  exit 0
} finally {
  if ($pageStarted) { [void][BistroRawPrinter]::EndPagePrinter($handle) }
  if ($docStarted) { [void][BistroRawPrinter]::EndDocPrinter($handle) }
  if ($handle -ne [IntPtr]::Zero) { [void][BistroRawPrinter]::ClosePrinter($handle) }
}
`;

function validPrinterName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && name === name.trim() && /^[\x20-\x7E]+$/.test(name) && !/[\\,"]/.test(name);
}

export interface WindowsSpoolResult { code: number | null; output: string; timedOut: boolean }
export interface WindowsPrinterOptions {
  platform?: NodeJS.Platform;
  runPowerShell?: (printerName: string, filePath: string, timeoutMs: number) => Promise<WindowsSpoolResult>;
}

export const HELPER_UNAVAILABLE = 'helper_unavailable';

/** Escape every non-ASCII character so the helper's stdin is pure ASCII regardless of console code page. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

interface HelperChild {
  stdin: { write(chunk: string): unknown } | null;
  stdout: NodeJS.EventEmitter & { setEncoding(encoding: BufferEncoding): unknown };
  stderr: NodeJS.EventEmitter & { setEncoding(encoding: BufferEncoding): unknown };
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}
export type SpawnHelper = () => HelperChild;

const spawnPowerShellHelper: SpawnHelper = () => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELPER_SCRIPT], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
}) as unknown as HelperChild;

interface PendingJob { id: string; output: string[]; timedOut: boolean; timer?: NodeJS.Timeout; resolve: (result: WindowsSpoolResult) => void }

/**
 * Keeps one PowerShell spooler alive so each Bar token skips PowerShell start-up
 * and the C# compile. Jobs run strictly one at a time. A timed-out or crashed
 * helper is killed and replaced on the next job; the result of the job in flight
 * keeps the same stage evidence the one-shot sender produced, so a failure after
 * "write-started" is still classified as uncertain and never auto-reprinted.
 */
export class WindowsSpoolHelper {
  private child: HelperChild | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private pending: PendingJob | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly spawnHelper: SpawnHelper = spawnPowerShellHelper) {}

  /** Starts the helper ahead of the first job. By default a failure is left for the next job to retry. */
  warmUp(timeoutMs: number, rethrow = false): Promise<void> {
    const ready = this.ensureReady(timeoutMs);
    return rethrow ? ready : ready.catch(() => undefined);
  }

  run(printerName: string, filePath: string, timeoutMs: number, startTimeoutMs = timeoutMs): Promise<WindowsSpoolResult> {
    const job = this.tail.then(() => this.runOne(printerName, filePath, timeoutMs, startTimeoutMs));
    this.tail = job.catch(() => undefined);
    return job;
  }

  stop(): void {
    const child = this.child;
    this.reset();
    child?.kill();
  }

  private reset(): void {
    this.child = null;
    this.ready = null;
    this.buffer = '';
  }

  private ensureReady(timeoutMs: number): Promise<void> {
    if (this.ready) return this.ready;
    const child = this.spawnHelper();
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.stop(); reject(new Error('helper_start_timeout')); } }, timeoutMs);
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      // Events from a helper that was already replaced (timed out, killed) must
      // never touch the next job, so every handler checks it is still current.
      const current = () => this.child === child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!current()) return;
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (line === 'READY') settle();
          else if (line) this.onLine(line);
        }
      });
      child.stderr.on('data', (chunk: string) => { if (current()) this.pending?.output.push(chunk.trim()); });
      child.once('error', (error) => {
        settle(error);
        if (!current()) return;
        this.reset();
        this.finish(null);
      });
      child.once('close', (code) => {
        settle(new Error(`helper_exit_${code}`));
        if (!current()) return;
        this.reset();
        // Exit code 0 only means stdin closed; it is never a job success.
        this.finish(code === 0 ? null : code);
      });
    });
    return this.ready;
  }

  private onLine(line: string): void {
    const job = this.pending;
    const space = line.indexOf(' ');
    if (!job || space < 0 || line.slice(0, space) !== job.id) return;
    const rest = line.slice(space + 1);
    job.output.push(rest);
    if (rest === 'DONE') this.finish(0);
    else if (rest.startsWith('FAIL ')) this.finish(Number(rest.split(' ')[1]) || 99);
  }

  private finish(code: number | null): void {
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    if (job.timer) clearTimeout(job.timer);
    job.resolve({ code, output: job.output.join('\n'), timedOut: job.timedOut });
  }

  private async runOne(printerName: string, filePath: string, timeoutMs: number, startTimeoutMs: number): Promise<WindowsSpoolResult> {
    const startedAt = Date.now();
    try {
      await this.ensureReady(Math.min(startTimeoutMs, timeoutMs));
    } catch (error) {
      // Nothing reached the spooler: safe to retry.
      return { code: null, output: `${HELPER_UNAVAILABLE}: ${(error as Error).message}`, timedOut: (error as Error).message === 'helper_start_timeout' };
    }
    const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
    return new Promise<WindowsSpoolResult>((resolve) => {
      const id = `j${++this.seq}`;
      const job: PendingJob = { id, output: [], timedOut: false, resolve };
      this.pending = job;
      job.timer = setTimeout(() => {
        job.timedOut = true;
        this.stop(); // the next job starts a fresh helper
        this.finish(null);
      }, remaining);
      try {
        this.child!.stdin!.write(asciiJson({ id, printer: printerName, file: filePath }) + '\n');
      } catch (error) {
        job.output.push(`helper_write_failed: ${(error as Error).message}`);
        this.stop();
        this.finish(null);
      }
    });
  }
}

const sharedHelper = new WindowsSpoolHelper();
let helperDisabled = false;

/**
 * Starts the shared Windows spooler helper early so the first USB token is fast.
 * Returns false (and switches this process to the one-shot sender) if it cannot start.
 */
export async function warmUpWindowsPrinter(timeoutMs: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'win32' || helperDisabled) return false;
  try {
    await sharedHelper.warmUp(timeoutMs, true);
    return true;
  } catch {
    helperDisabled = true;
    return false;
  }
}

export function stopWindowsPrinter(): void {
  sharedHelper.stop();
}

/**
 * Default sender: the persistent helper, falling back to the proven one-shot
 * PowerShell sender when the helper cannot start. A helper start failure never
 * reaches the spooler, so retrying the same job one-shot cannot double-print.
 */
async function defaultRunner(printerName: string, filePath: string, timeoutMs: number): Promise<WindowsSpoolResult> {
  if (!helperDisabled) {
    const startedAt = Date.now();
    const result = await sharedHelper.run(printerName, filePath, timeoutMs, Math.min(15_000, Math.floor(timeoutMs / 2)));
    if (!result.output.startsWith(HELPER_UNAVAILABLE)) return result;
    helperDisabled = true;
    return runOneShot(printerName, filePath, Math.max(1_000, timeoutMs - (Date.now() - startedAt)));
  }
  return runOneShot(printerName, filePath, timeoutMs);
}

function runOneShot(printerName: string, filePath: string, timeoutMs: number): Promise<WindowsSpoolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ONE_SHOT_SCRIPT], {
      windowsHide: true,
      env: { ...process.env, BISTRO_PRINTER_NAME: printerName, BISTRO_PRINT_FILE: filePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
}

export async function sendRawToWindowsPrinter(printer: PrinterConfig, bytes: Buffer, timeoutMs: number, options: WindowsPrinterOptions = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') throw Object.assign(new Error('windows_printer_requires_windows'), { delivery: 'retryable_failed' as const });
  if (!validPrinterName(printer.host)) throw Object.assign(new Error('invalid_windows_printer_name'), { delivery: 'retryable_failed' as const });

  const directory = await mkdtemp(join(os.tmpdir(), 'bistro-print-'));
  const filePath = join(directory, 'job.bin');
  try {
    await writeFile(filePath, bytes);
    const result = await (options.runPowerShell ?? defaultRunner)(printer.host, filePath, timeoutMs);
    if (result.code !== 0 || result.timedOut) {
      const delivery = result.output.includes('STAGE:write-started') ? 'uncertain' : 'retryable_failed';
      const detail = result.timedOut ? 'powershell_timeout' : (result.output.match(/WIN32:\d+/)?.[0] ?? `powershell_exit_${result.code}`);
      throw Object.assign(new Error(`windows_printer_failed: ${detail}`), { delivery });
    }
    // Success means the Windows spooler accepted the full job, not that paper was physically confirmed.
  } catch (error) {
    const e = error as Error & { delivery?: 'retryable_failed' | 'uncertain' };
    if (!e.delivery) e.delivery = 'retryable_failed';
    throw e;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
