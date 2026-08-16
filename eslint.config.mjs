import { config } from '@n8n/node-cli/eslint';

// The n8n community-node rules (no Node built-ins, no process, no secrets)
// are for the shipped node code; the test suite legitimately spins up a local
// HTTP server and reads env vars.
export default [...config, { ignores: ['tests/**', 'vitest.config.ts'] }];
