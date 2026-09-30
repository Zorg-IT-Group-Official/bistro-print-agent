import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface AgentConfig {
  apiBaseUrl: string;
  credential: string;
  databasePath: string;
  pollMs: number;
  heartbeatMs: number;
  connectTimeoutMs: number;
  windowsPrintTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const apiBaseUrl = env.BISTRO_API_URL;
  const credential = loadCredential(env);
  if (!apiBaseUrl || !credential) throw new Error('BISTRO_API_URL and a protected print-agent credential are required');
  const url = new URL(apiBaseUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('The print agent requires HTTPS except for loopback development');
  }
  if (credential.length < 32) throw new Error('Agent credential is invalid');
  const windowsPrintTimeoutMs = Number(env.BISTRO_AGENT_WINDOWS_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(windowsPrintTimeoutMs) || windowsPrintTimeoutMs < 1 || windowsPrintTimeoutMs >= 45_000) {
    throw new Error('BISTRO_AGENT_WINDOWS_TIMEOUT_MS must be an integer from 1 to 44999 (below the 45 second server lease)');
  }
  return {
    apiBaseUrl: url.toString().replace(/\/$/, ''), credential,
    databasePath: env.BISTRO_AGENT_DB ?? './data/print-agent.sqlite',
    pollMs: Number(env.BISTRO_AGENT_POLL_MS ?? 2000),
    heartbeatMs: Number(env.BISTRO_AGENT_HEARTBEAT_MS ?? 30_000),
    connectTimeoutMs: Number(env.BISTRO_AGENT_CONNECT_TIMEOUT_MS ?? 5000),
    windowsPrintTimeoutMs,
  };
}
function loadCredential(env: NodeJS.ProcessEnv): string | undefined {
  // Plain environment credentials are intentionally opt-in for development only.
  if (env.BISTRO_AGENT_CREDENTIAL) {
    if (env.BISTRO_AGENT_ALLOW_PLAINTEXT_CREDENTIAL !== 'true') {
      throw new Error('Plaintext agent credentials are disabled; use a Windows DPAPI credential file or explicitly opt in for local development');
    }
    return env.BISTRO_AGENT_CREDENTIAL;
  }
  const path = env.BISTRO_AGENT_CREDENTIAL_FILE ?? (process.platform === 'win32'
    ? join(env.ProgramData ?? 'C:\\ProgramData', 'BistroOS', 'PrintAgent', 'credential.dpapi') : undefined);
  if (!path || !existsSync(path)) return undefined;
  if (process.platform !== 'win32') throw new Error('DPAPI credential files can only be read on Windows under the enrolling Windows account');
  const script = "$ErrorActionPreference='Stop'; $secure=ConvertTo-SecureString -String (Get-Content -Raw -LiteralPath $env:BISTRO_DPAPI_FILE); $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }";
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...env, BISTRO_DPAPI_FILE: path }, timeout: 10_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error('Unable to decrypt the Windows DPAPI agent credential');
  return result.stdout.trim();
}
