import { Socket } from 'node:net';
import { PrinterConfig } from './types.js';

function isPrivateIpv4(host: string): boolean {
  const p = host.split('.').map(Number);
  return p.length === 4 && p.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) &&
    (p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254));
}

export async function sendRaw(printer: PrinterConfig, bytes: Buffer, timeoutMs: number): Promise<void> {
  if (!isPrivateIpv4(printer.host) || printer.port < 1 || printer.port > 65535) throw new Error('invalid_printer_target: Refusing non-private printer endpoint');
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    let writeStarted = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; socket.destroy();
      if (!error) resolve();
      else if (!writeStarted) reject(Object.assign(error, { delivery: 'retryable_failed' }));
      else reject(Object.assign(error, { delivery: 'uncertain' }));
    };
    socket.setTimeout(timeoutMs);
    socket.once('error', (error) => finish(error));
    socket.once('timeout', () => finish(new Error('printer_socket_timeout')));
    socket.connect(printer.port, printer.host, () => {
      writeStarted = true;
      socket.end(bytes, () => finish());
    });
  });
}
