import { AgentConfig } from './config.js';
import { ClaimedJob } from './types.js';

export class PrintApi {
  constructor(private readonly config: AgentConfig) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.config.apiBaseUrl + '/printing/agent/' + path, {
      ...init, headers: { authorization: 'Bearer ' + this.config.credential, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as { success?: boolean; data?: T; message?: string } | null;
    if (!response.ok || !body?.success) throw new Error('backend_' + response.status + ': ' + (body?.message ?? 'print API request failed'));
    return body.data as T;
  }
  heartbeat(agentVersion: string, hostname: string, osVersion: string) {
    return this.request<{ serverTime: string; pollAfterMs: number }>('heartbeat', { method: 'POST', body: JSON.stringify({ agentVersion, hostname, osVersion }) });
  }
  claim() { return this.request<ClaimedJob | null>('jobs/claim', { method: 'POST', body: '{}' }); }
  sending(id: string) { return this.request<{ accepted: boolean }>('jobs/' + encodeURIComponent(id) + '/sending', { method: 'POST', body: '{}' }); }
  result(id: string, status: 'sent' | 'retryable_failed' | 'failed' | 'uncertain', errorCode?: string, errorMessage?: string) {
    return this.request<{ id: string; status: string }>('jobs/' + encodeURIComponent(id) + '/result', { method: 'POST', body: JSON.stringify({ status, errorCode, errorMessage }) });
  }
}
