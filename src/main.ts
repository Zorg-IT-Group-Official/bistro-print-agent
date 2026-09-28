import { PrintAgentRunner } from './agent.js';
import { loadConfig } from './config.js';

const runner = new PrintAgentRunner(loadConfig());
process.once('SIGINT', () => runner.stop());
process.once('SIGTERM', () => runner.stop());
void runner.run().catch((error: Error) => { process.stderr.write((error.stack ?? error.message) + '\n'); process.exitCode = 1; });
