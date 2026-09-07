import { describe, expect, it } from 'vitest';
import {
	buildJsonRpcRequest,
	compact,
	describeToolError,
	extractBinaryResource,
	parseJsonParameter,
	parseMcpBody,
	splitList,
	toolResultToData,
} from '../nodes/GuniwebSap/mcp';

describe('buildJsonRpcRequest', () => {
	it('builds a JSON-RPC 2.0 request with and without params', () => {
		expect(buildJsonRpcRequest('tools/list')).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(buildJsonRpcRequest('tools/call', { name: 'x', arguments: {} }, 7)).toEqual({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'x', arguments: {} },
		});
	});
});

describe('parseMcpBody', () => {
	it('accepts an already parsed JSON-RPC object', () => {
		const r = parseMcpBody({ jsonrpc: '2.0', id: 1, result: { ok: true } });
		expect(r).toEqual({ ok: true, value: { jsonrpc: '2.0', id: 1, result: { ok: true } } });
	});

	it('accepts a JSON string (application/json answer)', () => {
		const r = parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
		expect(r.ok && r.value.result).toEqual({ tools: [] });
	});

	it('parses a Server-Sent-Events body and picks the message with an id', () => {
		const sse = [
			'event: message',
			'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
			'',
			'event: message',
			'data: {"result":{"content":[{"type":"text","text":"hi"}]},"jsonrpc":"2.0","id":1}',
			'',
			'',
		].join('\n');
		const r = parseMcpBody(sse);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.id).toBe(1);
	});

	it('handles CRLF line endings and multi-line data', () => {
		const sse = 'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":2,"result":{}}\r\n\r\n';
		const r = parseMcpBody(sse);
		expect(r.ok && r.value.id).toBe(2);
	});

	it('reports empty, non-JSON and non-JSON-RPC bodies without throwing', () => {
		expect(parseMcpBody('')).toMatchObject({ ok: false, reason: expect.stringMatching(/Empty/) });
		expect(parseMcpBody('{nope')).toMatchObject({ ok: false, reason: expect.stringMatching(/JSON/) });
		expect(parseMcpBody('<html>oops</html>')).toMatchObject({ ok: false });
		expect(parseMcpBody({ foo: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/2\.0/) });
		expect(parseMcpBody(42)).toMatchObject({ ok: false });
	});
});

describe('toolResultToData', () => {
	it('prefers structuredContent', () => {
		expect(toolResultToData({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"b":2}' }] })).toEqual({ a: 1 });
	});

	it('parses a single JSON text block', () => {
		expect(toolResultToData({ content: [{ type: 'text', text: '{"results":[1,2],"count":2}' }] })).toEqual({
			results: [1, 2],
			count: 2,
		});
	});

	it('wraps non-JSON text and returns arrays for several blocks', () => {
		expect(toolResultToData({ content: [{ type: 'text', text: 'plain' }] })).toEqual({ text: 'plain' });
		expect(
			toolResultToData({
				content: [
					{ type: 'text', text: '{"a":1}' },
					{ type: 'text', text: 'x' },
				],
			}),
		).toEqual([{ a: 1 }, { text: 'x' }]);
	});

	it('returns content as-is when there is no text', () => {
		expect(toolResultToData({ content: [{ type: 'image', data: 'abc' }] })).toEqual([{ type: 'image', data: 'abc' }]);
		expect(toolResultToData({})).toEqual({});
	});
});

describe('describeToolError', () => {
	it('joins the server error fields into one message', () => {
		const r = describeToolError({
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({ error: 'SAP 401', hint: 'Check SAP_CLIENT', code: 'AUTH' }),
				},
			],
		});
		expect(r.message).toBe('SAP 401 — Check SAP_CLIENT');
		expect(r.details).toMatchObject({ code: 'AUTH' });
	});

	it('describes a failed test-connection by its failed stage', () => {
		const r = describeToolError({
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						status: 'failed',
						failedStage: 'auth',
						stages: [
							{ stage: 'dns', status: 'ok' },
							{ stage: 'auth', status: 'failed', detail: 'HTTP 401 from SAP' },
						],
					}),
				},
			],
		});
		expect(r.message).toBe('Failed at stage "auth": HTTP 401 from SAP');
	});

	it('falls back to plain text and to a generic message', () => {
		expect(describeToolError({ content: [{ type: 'text', text: 'boom' }] }).message).toBe('boom');
		expect(describeToolError({ content: [] }).message).toMatch(/reported an error/);
	});
});

describe('parameter helpers', () => {
	it('parseJsonParameter accepts strings and objects, rejects invalid JSON', () => {
		expect(parseJsonParameter('{"a":1}', 'x')).toEqual({ ok: true, value: { a: 1 } });
		expect(parseJsonParameter({ a: 1 }, 'x')).toEqual({ ok: true, value: { a: 1 } });
		expect(parseJsonParameter('', 'x')).toEqual({ ok: true, value: undefined });
		expect(parseJsonParameter('{oops', 'key')).toMatchObject({ ok: false, reason: expect.stringContaining('key') });
	});

	it('splitList and compact', () => {
		expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
		expect(splitList('')).toBeUndefined();
		expect(splitList(['x'])).toEqual(['x']);
		expect(compact({ a: 1, b: undefined, c: '', d: null, e: 0, f: false })).toEqual({ a: 1, e: 0, f: false });
	});
});

describe('extractBinaryResource', () => {
	const blob = Buffer.from('%PDF-1.7').toString('base64');
	const result = {
		content: [
			{
				type: 'text',
				text: '{"status":200,"fileName":"auftrag.pdf","contentType":"application/pdf","bytes":8}',
			},
			{
				type: 'resource',
				resource: { uri: 'sap://AttachmentContentSet/auftrag.pdf', mimeType: 'application/pdf', blob },
			},
		],
	};

	// Ohne diesen Weg landeten die Bytes als base64-Zeichenkette im JSON —
	// genau das, was die Binärform vermeiden soll.
	it('picks the blob out of a resource block', () => {
		const found = extractBinaryResource(result);
		expect(found).toBeDefined();
		expect(found?.data.toString()).toBe('%PDF-1.7');
		expect(found?.mimeType).toBe('application/pdf');
		expect(found?.fileName).toBe('auftrag.pdf');
	});

	it('takes the file name from the metadata block, not from the URI', () => {
		const withOddUri = {
			content: [
				{ type: 'text', text: '{"fileName":"Prüfbericht.pdf"}' },
				{ type: 'resource', resource: { uri: 'sap://x/content', mimeType: 'application/pdf', blob } },
			],
		};
		expect(extractBinaryResource(withOddUri)?.fileName).toBe('Prüfbericht.pdf');
	});

	it('falls back to the last URI segment when no metadata names a file', () => {
		const noMeta = {
			content: [
				{ type: 'resource', resource: { uri: 'sap://x/beleg.pdf', mimeType: 'application/pdf', blob } },
			],
		};
		expect(extractBinaryResource(noMeta)?.fileName).toBe('beleg.pdf');
	});

	it('returns undefined for a plain text result', () => {
		expect(extractBinaryResource({ content: [{ type: 'text', text: '{"ok":true}' }] })).toBeUndefined();
	});

	it('ignores a resource block that carries text instead of a blob', () => {
		const textResource = {
			content: [{ type: 'resource', resource: { uri: 'sap://x', text: 'not binary' } }],
		};
		expect(extractBinaryResource(textResource)).toBeUndefined();
	});
});

describe('toolResultToData with a resource block', () => {
	it('returns the metadata text, not the base64 blob', () => {
		const data = toolResultToData({
			content: [
				{ type: 'text', text: '{"fileName":"auftrag.pdf","bytes":8}' },
				{ type: 'resource', resource: { uri: 'sap://x', mimeType: 'application/pdf', blob: 'AAA=' } },
			],
		});
		expect(data).toEqual({ fileName: 'auftrag.pdf', bytes: 8 });
	});
});
