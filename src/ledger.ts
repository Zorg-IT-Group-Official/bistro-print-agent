import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type LedgerStatus = 'claimed' | 'sending' | 'sent' | 'retryable_failed' | 'uncertain' | 'failed';

export class PrintLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    const resolved = resolve(path); mkdirSync(dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, printer_id TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  private persist(): void {
    // SQLite writes transactionally; checkpoint WAL before allowing the runner to
    // proceed, so job state survives power loss/restart on the local disk.
    this.db.exec('PRAGMA wal_checkpoint(FULL)');
  }
  get(jobId: string) { return this.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId) as { job_id: string; payload_hash: string; printer_id: string; status: LedgerStatus; last_error: string | null } | undefined; }
  recordClaim(jobId: string, payload: unknown, printer: { id: string }): 'new' | 'duplicate' | 'payload_mismatch' {
    const payloadHash = createHash('sha256').update(JSON.stringify({ payload, printer })).digest('hex');
    const existing = this.get(jobId);
    if (existing) return existing.payload_hash === payloadHash && existing.printer_id === printer.id ? 'duplicate' : 'payload_mismatch';
    this.db.prepare('INSERT INTO jobs(job_id,payload_hash,printer_id,status,attempt_count) VALUES(?,?,?,\'claimed\',1)').run(jobId, payloadHash, printer.id);
    this.persist();
    return 'new';
  }
  setStatus(jobId: string, status: LedgerStatus, error?: string): void {
    this.db.prepare('UPDATE jobs SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?').run(status, error ?? null, jobId);
    this.persist();
  }
  pendingRecovery() { return this.db.prepare("SELECT job_id FROM jobs WHERE status IN ('claimed','sending')").all() as { job_id: string }[]; }
  close(): void { this.db.close(); }
}
