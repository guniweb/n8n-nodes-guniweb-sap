/**
 * Pure helpers for talking to an MCP server over Streamable HTTP — no n8n
 * dependency, so they are unit-testable in isolation.
 *
 * The GuniWeb SAP MCP Server runs Streamable HTTP in stateless mode: every
 * JSON-RPC request is self-contained (no `initialize` handshake, no session
 * id) and the answer arrives either as `application/json` or as a short
 * `text/event-stream` body with a single `data:` line. Both shapes are handled
 * here.
 */

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number | string | null;
	result?: unknown;
	error?: JsonRpcError;
}

export interface McpToolContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface McpToolResult {
	content?: McpToolContent[];
	structuredContent?: unknown;
	isError?: boolean;
	[key: string]: unknown;
}

export interface McpToolInfo {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	[key: string]: unknown;
}

/** Outcome of a parse step — this module never throws, so callers decide how to report. */
export type ParseOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; reason: string; details?: unknown };

/** Builds a JSON-RPC 2.0 request object. */
export function buildJsonRpcRequest(
	method: string,
	params?: Record<string, unknown>,
	id: number | string = 1,
): { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> } {
	return params === undefined
		? { jsonrpc: '2.0', id, method }
		: { jsonrpc: '2.0', id, method, params };
}

/**
 * Turns an HTTP response body into a JSON-RPC response. Accepts an already
 * parsed object, a JSON string, or a Server-Sent-Events body (`event: message`
 * / `data: {...}` lines).
 */
export function parseMcpBody(body: unknown): ParseOutcome<JsonRpcResponse> {
	if (body !== null && typeof body === 'object') {
		return asJsonRpc(body);
	}
	if (typeof body !== 'string') {
		return { ok: false, reason: `Unexpected MCP response body of type ${typeof body}.` };
	}
	const text = body.trim();
	if (text.length === 0) {
		return { ok: false, reason: 'Empty response from the MCP server.' };
	}
	// Plain JSON first — the fast path when the server answers application/json.
	if (text.startsWith('{') || text.startsWith('[')) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { ok: false, reason: 'Response is not valid JSON.', details: text.slice(0, 500) };
		}
		return asJsonRpc(parsed);
	}
	// Server-Sent Events: collect the data lines of every event, take the last
	// JSON-RPC message that carries an id (notifications have none).
	const messages: JsonRpcResponse[] = [];
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim())
			.join('\n');
		if (!data) continue;
		try {
			const parsed = JSON.parse(data);
			if (parsed && typeof parsed === 'object' && 'jsonrpc' in parsed) {
				messages.push(parsed as JsonRpcResponse);
			}
		} catch {
			// A non-JSON data line (e.g. a keep-alive) is not an error.
		}
	}
	const withId = messages.filter((m) => m.id !== undefined && m.id !== null);
	const message = withId[withId.length - 1] ?? messages[messages.length - 1];
	if (!message) {
		return {
			ok: false,
			reason: 'No JSON-RPC message in the event stream response.',
			details: text.slice(0, 500),
		};
	}
	return { ok: true, value: message };
}

function asJsonRpc(value: unknown): ParseOutcome<JsonRpcResponse> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, reason: 'MCP response is not a JSON-RPC object.', details: value };
	}
	const obj = value as Record<string, unknown>;
	if (obj.jsonrpc !== '2.0') {
		return { ok: false, reason: 'MCP response is not a JSON-RPC 2.0 message.', details: value };
	}
	return { ok: true, value: obj as unknown as JsonRpcResponse };
}

/**
 * Unwraps a `tools/call` result into plain data for n8n: `structuredContent`
 * if present, otherwise the text content parsed as JSON (falling back to
 * `{ text }`). Several text blocks become an array.
 */
export function toolResultToData(result: McpToolResult): unknown {
	if (result.structuredContent !== undefined) return result.structuredContent;
	const texts = (result.content ?? [])
		.filter((c) => c.type === 'text' && typeof c.text === 'string')
		.map((c) => c.text as string);
	if (texts.length === 0) return result.content ?? {};
	const parsed = texts.map(parseLoose);
	return parsed.length === 1 ? parsed[0] : parsed;
}

function parseLoose(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// fall through
		}
	}
	return { text };
}

/**
 * Best-effort human message for a failed tool call — the SAP MCP Server
 * answers errors as JSON text with `error`, `code`, `hint`/`nextStep`.
 */
export function describeToolError(result: McpToolResult): { message: string; details: unknown } {
	const data = toolResultToData(result);
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const obj = data as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of ['error', 'message', 'detail', 'hint', 'nextStep', 'suggestion']) {
			const value = obj[key];
			if (typeof value === 'string' && value.trim()) parts.push(value.trim());
		}
		if (parts.length > 0) return { message: parts.join(' — '), details: data };
		if (typeof obj.text === 'string' && Object.keys(obj).length === 1) {
			return { message: obj.text, details: data };
		}
		// test-connection style: { status: 'failed', failedStage, stages: [{ stage, status, detail }] }
		if (typeof obj.failedStage === 'string' && Array.isArray(obj.stages)) {
			const failed = (obj.stages as Array<Record<string, unknown>>).find(
				(s) => s.stage === obj.failedStage,
			);
			const detail = typeof failed?.detail === 'string' ? `: ${failed.detail}` : '';
			return { message: `Failed at stage "${obj.failedStage}"${detail}`, details: data };
		}
		// Anything else: the first short string values, so the message says something.
		const strings = Object.entries(obj)
			.filter(([, v]) => typeof v === 'string' && (v as string).length <= 300)
			.slice(0, 3)
			.map(([k, v]) => `${k}: ${v}`);
		if (strings.length > 0) return { message: strings.join(' — '), details: data };
	}
	return { message: 'The SAP MCP Server reported an error.', details: data };
}

/** Parses a JSON node parameter that n8n hands over as string or as object. */
export function parseJsonParameter(value: unknown, name: string): ParseOutcome<unknown> {
	if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
	if (typeof value !== 'string') return { ok: true, value };
	try {
		return { ok: true, value: JSON.parse(value) };
	} catch {
		return { ok: false, reason: `Parameter "${name}" must be valid JSON.`, details: value };
	}
}

/** Splits a comma-separated list into trimmed, non-empty entries. */
export function splitList(value: unknown): string[] | undefined {
	if (typeof value !== 'string') return Array.isArray(value) ? (value as string[]) : undefined;
	const list = value
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return list.length > 0 ? list : undefined;
}

/** Removes undefined/empty-string entries so optional tool arguments stay optional. */
export function compact(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null || value === '') continue;
		out[key] = value;
	}
	return out;
}
