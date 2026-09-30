import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { PrinterConfig } from './types.js';

const POWERSHELL_SCRIPT = String.raw`
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

function runPowerShell(printerName: string, filePath: string, timeoutMs: number): Promise<WindowsSpoolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT], {
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
    const result = await (options.runPowerShell ?? runPowerShell)(printer.host, filePath, timeoutMs);
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
