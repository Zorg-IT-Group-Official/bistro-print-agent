# Bistro OS local print agent

> **Repository snapshot:** The first repository commit imports the current verified working tree and already includes the Phase 2 `order_update` renderer. It is not a pre-Phase-2 baseline.

This Windows-side process claims durable jobs from Bistro OS over outbound HTTPS and sends ESC/POS bytes to the printer's private TCP endpoint. It does not expose an HTTP listener, use browser printing, or connect the cloud API to the restaurant LAN. It does not mark orders ready/cooked.

## Current capabilities and limits

- Durable SQLite job ledger (`BISTRO_AGENT_DB`) prevents a completed or uncertain job from being printed again after restart and detects a changed payload/printer for a reused job ID.
- Job claim, sending transition, result, heartbeat and branch-scoped agent identity use the authenticated `/printing/agent/*` API.
- ESC/POS text rendering for 58mm, 32 columns, bold, 58mm cut command when enabled; no beeper command is emitted. `sent` means the TCP stack accepted the bytes, not that a printer sensor confirmed paper output.
- Text mode is intentionally printable ASCII only. Non-ASCII names fail visibly rather than becoming mojibake. A validated raster/code-page renderer is required for Bengali or other scripts; do not enable raster in a profile with this build.
- Automatic resend is allowed only before TCP writing begins. Failures after writing begins are `uncertain`; an operator can inspect the printer and request an explicit reprint.
- `order_update` jobs render an immutable revision delta with `ORDER UPDATE / NOT A NEW ORDER`, station-only changes, and the station's current item reference. Admin suppresses browser auto-print only when an event confirms durable print jobs; legacy events without confirmed jobs retain the browser fallback. Confirmed durable updates print through this agent, with explicit reprint backed by the saved revision job.
- Text mode still rejects Bengali and other non-ASCII item names. Verify production-language output on the actual 58mm printer before deployment; Phase 2 does not add raster or Bengali rendering.
- The process only accepts private/local IPv4 endpoints received in its authenticated claimed job. It never listens for arbitrary browser/LAN commands.

## Configure and run for development

Use Node.js 22.5+ (built-in `node:sqlite`; 24.x tested), then:

```powershell
npm ci
npm test
npm run build
$env:BISTRO_API_URL = 'https://your-api.example'
$env:BISTRO_AGENT_ALLOW_PLAINTEXT_CREDENTIAL = 'true' # local development only
$env:BISTRO_AGENT_CREDENTIAL = '<one-time credential returned by enrollment>'
$env:BISTRO_AGENT_DB = 'C:\ProgramData\BistroOS\PrintAgent\ledger.sqlite'
node .\dist\src\main.js
```

Create the 10-minute one-use enrollment token from the authenticated Settings API, run `POST /printing/agent/enroll` with that token in `X-Enrollment-Token`, then protect the returned credential for the dedicated Windows account with DPAPI. In a PowerShell window running as that account, type the one-time credential at the secure prompt (never as a command argument or environment variable):

```powershell
$agentDir = Join-Path $env:ProgramData 'BistroOS\PrintAgent'
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
$secure = Read-Host 'Paste one-time agent credential' -AsSecureString
$protected = ConvertFrom-SecureString -SecureString $secure
[IO.File]::WriteAllText((Join-Path $agentDir 'credential.dpapi'), $protected)
$secure.Dispose()
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $agentDir /inheritance:r
icacls $agentDir /grant:r "${identity}:(OI)(CI)F" 'BUILTIN\Administrators:(OI)(CI)F'
```

The agent decrypts that file through Windows PowerShell at startup. Restrict the SQLite directory ACL in the same way, and use Windows Task Scheduler to start the agent at system startup with restart-on-failure. Set only `BISTRO_API_URL` in the task environment. This repository does not install a Windows service or configure the machine automatically.

## Restaurant installation checks

1. Ensure the Windows PC can reach the configured printer on the restaurant LAN and that outbound HTTPS to the Bistro API works.
2. From PowerShell on that PC, verify `Test-NetConnection <printer-private-ip> -Port 9100` succeeds. Use the actual restaurant LAN settings; do not change router/printer addressing as part of agent deployment.
3. Create a printer profile through the branch-scoped API using the printer's private IP as `host`, `port=9100`, and `paperWidthMm=58`. Assign that profile to the intended active kitchen station.
4. Enroll the agent for that branch, start it, then enqueue one explicit Test Print. Confirm text and cutter physically on the target printer before enabling automatic KOT assignments.
5. Place one controlled test order. Confirm exactly one station job appears and the matching station printer prints it. Test reprint only through the explicit reprint action.

There is no claim of physical printer validation until those checks are completed on the restaurant PC and printer.
