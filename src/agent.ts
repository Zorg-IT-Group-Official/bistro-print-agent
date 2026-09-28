import os from 'node:os';
import { AgentConfig } from './config.js';
import { PrintApi } from './api.js';
import { PrintLedger } from './ledger.js';
import { renderKot } from './renderer.js';
import { sendRaw } from './tcp-printer.js';
import { ClaimedJob } from './types.js';

const version = '0.1.0';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (event: string, fields: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), level: 'info', event, ...fields }) + '\n');

export class PrintAgentRunner {
  private readonly api: PrintApi;
  private readonly ledger: PrintLedger;
  private stopping = false;
  private lastHeartbeat = 0;

  constructor(private readonly config: AgentConfig, ledgerPath = config.databasePath, private readonly send = sendRaw) {
    this.api = new PrintApi(config); this.ledger = new PrintLedger(ledgerPath);
  }

  async process(job: ClaimedJob): Promise<void> {
    const recorded = this.ledger.recordClaim(job.id, job.payload, job.printer);
    const local = this.ledger.get(job.id)!;
    if (recorded === 'payload_mismatch') {
      await this.api.result(job.id, 'uncertain', 'payload_mismatch', 'A previously seen job ID arrived with a different payload or printer configuration');
      throw new Error('payload_mismatch');
    }
    if (local.status === 'sent' || local.status === 'uncertain' || local.status === 'failed') {
      if (local.status !== 'sent') await this.api.result(job.id, 'uncertain', 'local_ledger_guard', 'Local ledger blocks automatic resend');
      return;
    }
    let bytes: Buffer;
    try {
      bytes = renderKot(job);
    } catch (error) {
      const e = error as Error;
      this.ledger.setStatus(job.id, 'failed', e.message);
      await this.api.result(job.id, 'failed', 'render_failed', e.message.slice(0, 500)).catch(() => undefined);
      log('print_failed', { jobId: job.id, status: 'failed', error: e.message });
      return;
    }

    try {
      await this.api.sending(job.id);
    } catch (error) {
      // No printer connection/write has started; the job is safe to retry after
      // the lease expires even if the sending transition response was lost.
      const e = error as Error;
      this.ledger.setStatus(job.id, 'retryable_failed', e.message);
      await this.api.result(job.id, 'retryable_failed', 'backend_sending_transition', e.message.slice(0, 500)).catch((ackError: Error) => log('result_ack_failed', { jobId: job.id, error: ackError.message }));
      return;
    }

    this.ledger.setStatus(job.id, 'sending');
    try {
      await this.send(job.printer, bytes, this.config.connectTimeoutMs);
    } catch (error) {
      const e = error as Error & { delivery?: 'retryable_failed' | 'uncertain' };
      const status = e.delivery === 'retryable_failed' ? 'retryable_failed' : 'uncertain';
      this.ledger.setStatus(job.id, status, e.message);
      await this.api.result(job.id, status, status === 'uncertain' ? 'delivery_uncertain' : 'printer_connection', e.message.slice(0, 500)).catch((ackError: Error) => log('result_ack_failed', { jobId: job.id, error: ackError.message }));
      log('print_failed', { jobId: job.id, status, error: e.message });
      return;
    }

    // Persist success before the acknowledgement request. If that request is
    // lost, a restart can never blindly print the already handed-off job again.
    this.ledger.setStatus(job.id, 'sent');
    await this.api.result(job.id, 'sent').catch((error: Error) => log('result_ack_failed', { jobId: job.id, status: 'sent', error: error.message }));
    log('print_sent', { jobId: job.id, printerId: job.printer.id, bytes: bytes.length });
  }

  private async recoverSending(): Promise<void> {
    for (const row of this.ledger.pendingRecovery()) {
      const local = this.ledger.get(row.job_id);
      if (local?.status === 'sending') {
        this.ledger.setStatus(row.job_id, 'uncertain', 'Agent restarted after sending began; do not auto-reprint');
        await this.api.result(row.job_id, 'uncertain', 'agent_restart_during_send', 'Physical delivery cannot be determined after agent restart').catch(() => undefined);
      }
    }
  }

  async run(): Promise<void> {
    await this.recoverSending();
    log('agent_started', { version, hostname: os.hostname(), platform: os.platform() });
    while (!this.stopping) {
      try {
        if (Date.now() - this.lastHeartbeat >= this.config.heartbeatMs) {
          await this.api.heartbeat(version, os.hostname(), os.type() + ' ' + os.release());
          this.lastHeartbeat = Date.now();
        }
        const job = await this.api.claim();
        if (job) await this.process(job);
        else await wait(this.config.pollMs);
      } catch (error) {
        log('agent_loop_error', { error: (error as Error).message });
        await wait(Math.min(30_000, this.config.pollMs * 4));
      }
    }
    this.close();
  }
  stop(): void { this.stopping = true; }
  close(): void { this.ledger.close(); }
}
