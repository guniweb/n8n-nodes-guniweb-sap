/**
 * transport.ts against (a) a small fake MCP server that behaves like the
 * GuniWeb SAP MCP Server (SSE answers, Bearer auth, isError tool results) and
 * (b) optionally a real server when SAP_MCP_URL / SAP_MCP_TOKEN are set.
 *
 * The n8n execution context is stubbed: `getCredentials`, `getNode` and
 * `helpers.httpRequestWithAuthentication` (implemented with fetch and the
 * subset of IHttpRequestOptions the transport uses).
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IHttpRequestOptions } from 'n8n-workflow';
import { callTool, listTools, mcpRequest } from '../nodes/GuniwebSap/transport';

const TOKEN = 'gsm_s22_testtoken';

function sse(payload: unknown): string {
	return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function startFakeServer(): Promise<{ server: Server; url: string }> {
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => {
			body += c;
		});
		req.on('end', () => {
			if (req.url !== '/mcp') {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Not Found' }));
				return;
			}
			if (req.headers.authorization !== `Bearer ${TOKEN}`) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Unauthorized' }));
				return;
			}
			const accept = String(req.headers.accept ?? '');
			if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
				res.writeHead(406, { 'Content-Type': 'application/json' });
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						error: { code: -32000, message: 'Not Acceptable' },
						id: null,
					}),
				);
				return;
			}
			const rpc = JSON.parse(body);
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			if (rpc.method === 'tools/list') {
				res.end(
					sse({
						jsonrpc: '2.0',
						id: rpc.id,
						result: {
							tools: [
								{ name: 'test-connection', title: 'Test SAP Connection', description: 'x\ny' },
								{ name: 'sap_query', description: 'q' },
							],
						},
					}),
				);
				return;
			}
			if (rpc.method === 'tools/call') {
				const { name, arguments: args } = rpc.params;
				if (name === 'sap_query') {
					res.end(
						sse({
							jsonrpc: '2.0',
							id: rpc.id,
							result: {
								content: [
									{
										type: 'text',
										text: JSON.stringify({ results: [{ id: 1, args }, { id: 2 }], count: 2 }),
									},
								],
							},
						}),
					);
					return;
				}
				if (name === 'sap_fail') {
					res.end(
						sse({
							jsonrpc: '2.0',
							id: rpc.id,
							result: {
								isError: true,
								content: [
									{ type: 'text', text: JSON.stringify({ error: 'SAP said no', hint: 'Try X' }) },
								],
							},
						}),
					);
					return;
				}
				res.end(
					sse({
						jsonrpc: '2.0',
						id: rpc.id,
						error: { code: -32602, message: `Tool ${name} not found` },
					}),
				);
				return;
			}
			res.end(sse({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			resolve({ server, url: `http://127.0.0.1:${port}` });
		});
	});
}

/** Minimal stand-in for IExecuteFunctions — only what transport.ts touches. */
function fakeContext(serverUrl: string, token: string | undefined) {
	return {
		getNode: () => ({ name: 'GuniWeb SAP', type: 'guniwebSap', typeVersion: 1, position: [0, 0], parameters: {} }),
		getCredentials: async () => ({ serverUrl, token, timeoutMs: 5000 }),
		helpers: {
			async httpRequestWithAuthentication(_cred: string, options: IHttpRequestOptions) {
				const headers: Record<string, string> = {
					...((options.headers as Record<string, string>) ?? {}),
				};
				if (token) headers.Authorization = `Bearer ${token}`;
				const res = await fetch(options.url as string, {
					method: options.method,
					headers,
					body: options.body as string,
				});
				const text = await res.text();
				return {
					statusCode: res.status,
					headers: Object.fromEntries(res.headers.entries()),
					body: text,
				};
			},
		},
	} as never;
}

describe('transport against a fake SAP MCP Server', () => {
	let server: Server;
	let url: string;

	beforeAll(async () => {
		({ server, url } = await startFakeServer());
	});
	afterAll(async () => {
		await new Promise<void>((r) => server.close(() => r()));
	});

	it('listTools returns the tool descriptors', async () => {
		const tools = await listTools.call(fakeContext(url, TOKEN));
		expect(tools.map((t) => t.name)).toEqual(['test-connection', 'sap_query']);
	});

	it('accepts a server URL with trailing slash or /mcp suffix', async () => {
		expect((await listTools.call(fakeContext(`${url}/`, TOKEN))).length).toBe(2);
		expect((await listTools.call(fakeContext(`${url}/mcp`, TOKEN))).length).toBe(2);
	});

	it('callTool sends arguments and returns the tool result', async () => {
		const result = await callTool.call(fakeContext(url, TOKEN), 'sap_query', { entitySet: 'A' });
		const text = result.content?.[0]?.text ?? '';
		expect(JSON.parse(text)).toMatchObject({ count: 2, results: [{ id: 1, args: { entitySet: 'A' } }, { id: 2 }] });
	});

	it('translates 401 into an actionable error', async () => {
		await expect(listTools.call(fakeContext(url, 'wrong'))).rejects.toThrow(/401|rejected the token/);
		await expect(listTools.call(fakeContext(url, undefined))).rejects.toThrow(/401|rejected the token/);
	});

	it('surfaces isError tool results with the server message', async () => {
		await expect(callTool.call(fakeContext(url, TOKEN), 'sap_fail', {})).rejects.toThrow(
			/sap_fail: SAP said no — Try X/,
		);
	});

	it('surfaces JSON-RPC errors', async () => {
		await expect(callTool.call(fakeContext(url, TOKEN), 'nope', {})).rejects.toThrow(/-32602.*not found/);
		await expect(mcpRequest.call(fakeContext(url, TOKEN), 'bogus/method')).rejects.toThrow(/-32601/);
	});

	it('reports 404 for a wrong path and connection errors for a wrong host', async () => {
		await expect(listTools.call(fakeContext(`${url}/nope/`, TOKEN))).rejects.toThrow(/404/);
		await expect(listTools.call(fakeContext('http://127.0.0.1:1', TOKEN))).rejects.toThrow(/Cannot reach/);
	});
});

const REAL_URL = process.env.SAP_MCP_URL;
const REAL_TOKEN = process.env.SAP_MCP_TOKEN;

describe.skipIf(!REAL_URL)('transport against a real GuniWeb SAP MCP Server (SAP_MCP_URL)', () => {
	it('lists tools and calls test-connection', async () => {
		const ctx = fakeContext(REAL_URL as string, REAL_TOKEN);
		const tools = await listTools.call(ctx);
		expect(tools.some((t) => t.name === 'test-connection')).toBe(true);
		const result = await callTool.call(ctx, 'test-connection', {}, undefined, { tolerateError: true });
		expect(result.content?.[0]?.type).toBe('text');
		expect(JSON.parse(result.content?.[0]?.text ?? '{}')).toHaveProperty('stages');
	});
});
