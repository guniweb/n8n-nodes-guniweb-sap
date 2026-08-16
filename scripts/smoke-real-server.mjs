#!/usr/bin/env node
// Smoke run of the built transport against a real GuniWeb SAP MCP Server.
//   npm run build && SAP_MCP_URL=http://localhost:8808 SAP_MCP_TOKEN=gsm_… node scripts/smoke-real-server.mjs
// Lists the tools the token may use and runs test-connection (a failed stage is reported, not thrown).
import { callTool, listTools } from '../dist/nodes/GuniwebSap/transport.js';

const serverUrl = process.env.SAP_MCP_URL;
const token = process.env.SAP_MCP_TOKEN;
if (!serverUrl) {
	console.error('Set SAP_MCP_URL (and SAP_MCP_TOKEN if the server requires one).');
	process.exit(2);
}

const ctx = {
	getNode: () => ({ name: 'GuniWeb SAP', type: 'guniwebSap', typeVersion: 1, position: [0, 0], parameters: {} }),
	getCredentials: async () => ({ serverUrl, token, timeoutMs: 30000 }),
	helpers: {
		async httpRequestWithAuthentication(_cred, options) {
			const headers = { ...(options.headers ?? {}) };
			if (token) headers.Authorization = `Bearer ${token}`;
			const res = await fetch(options.url, { method: options.method, headers, body: options.body });
			return { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() };
		},
	},
};

const tools = await listTools.call(ctx);
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(', '));
const result = await callTool.call(ctx, 'test-connection', {}, undefined, { tolerateError: true });
console.log(result.content?.[0]?.text ?? JSON.stringify(result));
