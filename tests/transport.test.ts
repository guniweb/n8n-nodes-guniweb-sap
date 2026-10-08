/**
 * transport.ts against an in-process stand-in for the GuniWeb SAP MCP Server:
 * the n8n helper `httpRequestWithAuthentication` is replaced by a responder
 * that answers like the real server does (SSE bodies, Bearer auth, isError
 * tool results, JSON-RPC errors) — no sockets, no Node built-ins, so the
 * community-node lint rules apply unchanged to the test code.
 *
 * A smoke run against a real server lives in scripts/smoke-real-server.mjs.
 */
import { describe, expect, it } from 'vitest';
import type { IHttpRequestOptions } from 'n8n-workflow';
import { callTool, listTools, mcpRequest } from '../nodes/GuniwebSap/transport';

const EXPECTED_BEARER = 'gsm_s22_fake';
const BASE = 'http://sap-mcp.test:8808';

interface Reply {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
}

function sse(payload: unknown): string {
	return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Behaves like the SAP MCP Server's /mcp endpoint for the cases under test. */
function fakeServer(options: IHttpRequestOptions, authorization: string | undefined): Reply {
	const url = new URL(options.url as string);
	if (url.hostname === 'unreachable.test') {
		throw new Error('getaddrinfo ENOTFOUND unreachable.test');
	}
	if (url.pathname !== '/mcp') {
		return { statusCode: 404, headers: {}, body: JSON.stringify({ error: 'Not Found' }) };
	}
	if (authorization !== `Bearer ${EXPECTED_BEARER}`) {
		return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Unauthorized' }) };
	}
	// A "user-basic" destination: personal SAP login required, echoed back for the test.
	const h = (options.headers as Record<string, string>) ?? {};
	if (url.hostname === 'user-basic.test') {
		if (!h['X-SAP-Username'] || !h['X-SAP-Password']) {
			return {
				statusCode: 401,
				headers: {},
				body: JSON.stringify({ error: 'SAP login required', hint: 'send X-SAP-Username' }),
			};
		}
	} else if (h['X-SAP-Username']) {
		return {
			statusCode: 400,
			headers: {},
			body: JSON.stringify({ error: 'Destination "s22" (authType basic) nimmt keine persönliche SAP-Anmeldung an' }),
		};
	}
	const accept = String((options.headers as Record<string, string>)?.Accept ?? '');
	if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
		return { statusCode: 406, headers: {}, body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable"},"id":null}' };
	}
	const rpc = JSON.parse(options.body as string);
	const ok = (payload: unknown): Reply => ({
		statusCode: 200,
		headers: { 'content-type': 'text/event-stream' },
		body: sse(payload),
	});
	if (rpc.method === 'whoami') {
		return ok({ jsonrpc: '2.0', id: rpc.id, result: { sapUser: h['X-SAP-Username'] ?? null } });
	}
	if (rpc.method === 'tools/list') {
		return ok({
			jsonrpc: '2.0',
			id: rpc.id,
			result: {
				tools: [
					{ name: 'test-connection', title: 'Test SAP Connection', description: 'x\ny' },
					{ name: 'sap_query', description: 'q' },
				],
			},
		});
	}
	if (rpc.method === 'tools/call') {
		const { name, arguments: args } = rpc.params;
		if (name === 'sap_query') {
			return ok({
				jsonrpc: '2.0',
				id: rpc.id,
				result: {
					content: [
						{ type: 'text', text: JSON.stringify({ results: [{ id: 1, args }, { id: 2 }], count: 2 }) },
					],
				},
			});
		}
		if (name === 'sap_fail') {
			return ok({
				jsonrpc: '2.0',
				id: rpc.id,
				result: {
					isError: true,
					content: [{ type: 'text', text: JSON.stringify({ error: 'SAP said no', hint: 'Try X' }) }],
				},
			});
		}
		if (name === 'diagnose') {
			return ok({
				jsonrpc: '2.0',
				id: rpc.id,
				result: {
					isError: true,
					content: [{ type: 'text', text: JSON.stringify({ status: 'failed', failedStage: 'auth', stages: [] }) }],
				},
			});
		}
		return ok({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: `Tool ${name} not found` } });
	}
	return ok({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
}

/** Minimal stand-in for IExecuteFunctions — only what transport.ts touches. */
function fakeContext(
	serverUrl: string,
	token: string | undefined,
	sap: { sapUsername?: string; sapPassword?: string } = {},
) {
	return {
		getNode: () => ({ name: 'GuniWeb SAP', type: 'guniwebSap', typeVersion: 1, position: [0, 0], parameters: {} }),
		getCredentials: async () => ({ serverUrl, token, timeoutMs: 5000, ...sap }),
		helpers: {
			async httpRequestWithAuthentication(_cred: string, options: IHttpRequestOptions) {
				return fakeServer(options, token ? `Bearer ${token}` : undefined);
			},
		},
	} as never;
}

describe('transport against a fake SAP MCP Server', () => {
	const url = BASE;

	it('listTools returns the tool descriptors', async () => {
		const tools = await listTools.call(fakeContext(url, EXPECTED_BEARER));
		expect(tools.map((t) => t.name)).toEqual(['test-connection', 'sap_query']);
	});

	it('accepts a server URL with trailing slash or /mcp suffix', async () => {
		expect((await listTools.call(fakeContext(`${url}/`, EXPECTED_BEARER))).length).toBe(2);
		expect((await listTools.call(fakeContext(`${url}/mcp`, EXPECTED_BEARER))).length).toBe(2);
	});

	it('callTool sends arguments and returns the tool result', async () => {
		const result = await callTool.call(fakeContext(url, EXPECTED_BEARER), 'sap_query', { entitySet: 'A' });
		const text = result.content?.[0]?.text ?? '';
		expect(JSON.parse(text)).toMatchObject({ count: 2, results: [{ id: 1, args: { entitySet: 'A' } }, { id: 2 }] });
	});

	it('translates 401 into an actionable error', async () => {
		await expect(listTools.call(fakeContext(url, 'wrong'))).rejects.toThrow(/401|rejected the token/);
		await expect(listTools.call(fakeContext(url, undefined))).rejects.toThrow(/401|rejected the token/);
	});

	it('surfaces isError tool results with the server message', async () => {
		await expect(callTool.call(fakeContext(url, EXPECTED_BEARER), 'sap_fail', {})).rejects.toThrow(
			/sap_fail: SAP said no — Try X/,
		);
	});

	it('surfaces JSON-RPC errors', async () => {
		await expect(callTool.call(fakeContext(url, EXPECTED_BEARER), 'nope', {})).rejects.toThrow(/-32602.*not found/);
		await expect(mcpRequest.call(fakeContext(url, EXPECTED_BEARER), 'bogus/method')).rejects.toThrow(/-32601/);
	});

	it('returns a failed diagnosis as data when tolerateError is set, throws otherwise', async () => {
		const ctx = fakeContext(url, EXPECTED_BEARER);
		await expect(callTool.call(ctx, 'diagnose', {})).rejects.toThrow(/Failed at stage "auth"/);
		const result = await callTool.call(ctx, 'diagnose', {}, undefined, { tolerateError: true });
		expect(result.isError).toBe(true);
	});

	it('sends the personal SAP login as X-SAP-Username/X-SAP-Password when both are set', async () => {
		const ctx = fakeContext('http://user-basic.test:8808', EXPECTED_BEARER, {
			sapUsername: 'MUELLER',
			sapPassword: 'geheim',
		});
		const result = (await mcpRequest.call(ctx, 'whoami')) as { sapUser: string };
		expect(result.sapUser).toBe('MUELLER');
	});

	it('explains a missing personal SAP login (401 "SAP login required") in the credential terms', async () => {
		const ctx = fakeContext('http://user-basic.test:8808', EXPECTED_BEARER);
		await expect(mcpRequest.call(ctx, 'whoami')).rejects.toThrow(/personal SAP login/);
	});

	it('surfaces the server message when a personal login is sent to a technical destination (400)', async () => {
		const ctx = fakeContext(url, EXPECTED_BEARER, { sapUsername: 'MUELLER', sapPassword: 'x' });
		await expect(mcpRequest.call(ctx, 'whoami')).rejects.toThrow(/400.*persönliche SAP-Anmeldung/);
	});

	it('does not send SAP headers when only one of user/password is set', async () => {
		const ctx = fakeContext(url, EXPECTED_BEARER, { sapUsername: 'MUELLER' });
		const result = (await mcpRequest.call(ctx, 'whoami')) as { sapUser: string | null };
		expect(result.sapUser).toBeNull();
	});

	it('reports 404 for a wrong path and connection errors for a wrong host', async () => {
		await expect(listTools.call(fakeContext(`${url}/nope/`, EXPECTED_BEARER))).rejects.toThrow(/404/);
		await expect(listTools.call(fakeContext('http://unreachable.test', EXPECTED_BEARER))).rejects.toThrow(/Cannot reach/);
	});
});

// W3C Trace Context: an optional traceparent travels as a header to /mcp, so
// the server can log it next to its correlationId.
describe('traceparent', () => {
	const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

	function capturingContext() {
		const seen: Array<Record<string, string>> = [];
		const ctx = {
			getNode: () => ({ name: 'GuniWeb SAP', type: 'guniwebSap', typeVersion: 1, position: [0, 0], parameters: {} }),
			getCredentials: async () => ({ serverUrl: BASE, token: EXPECTED_BEARER, timeoutMs: 5000 }),
			helpers: {
				async httpRequestWithAuthentication(_cred: string, options: IHttpRequestOptions) {
					seen.push({ ...((options.headers as Record<string, string>) ?? {}) });
					return fakeServer(options, `Bearer ${EXPECTED_BEARER}`);
				},
			},
		} as never;
		return { ctx, seen };
	}

	it('sends the traceparent header on tools/call when set', async () => {
		const { ctx, seen } = capturingContext();
		await callTool.call(ctx, 'sap_query', {}, 0, { traceparent: TRACEPARENT });
		expect(seen[0]?.traceparent).toBe(TRACEPARENT);
	});

	it('sends it on tools/list as well', async () => {
		const { ctx, seen } = capturingContext();
		await listTools.call(ctx, { traceparent: TRACEPARENT });
		expect(seen[0]?.traceparent).toBe(TRACEPARENT);
	});

	it('trims the value and sends nothing when it is empty', async () => {
		const { ctx, seen } = capturingContext();
		await callTool.call(ctx, 'sap_query', {}, 0, { traceparent: `  ${TRACEPARENT} ` });
		await callTool.call(ctx, 'sap_query', {}, 0, { traceparent: '   ' });
		await callTool.call(ctx, 'sap_query', {}, 0);
		expect(seen[0]?.traceparent).toBe(TRACEPARENT);
		expect(seen[1]).not.toHaveProperty('traceparent');
		expect(seen[2]).not.toHaveProperty('traceparent');
	});

	it('leaves the format check to the server, but never sends a line break', async () => {
		const { ctx, seen } = capturingContext();
		await callTool.call(ctx, 'sap_query', {}, 0, { traceparent: 'not-w3c' });
		await callTool.call(ctx, 'sap_query', {}, 0, { traceparent: `${TRACEPARENT}\r\nX-Evil: 1` });
		expect(seen[0]?.traceparent).toBe('not-w3c');
		expect(seen[1]).not.toHaveProperty('traceparent');
	});
});
