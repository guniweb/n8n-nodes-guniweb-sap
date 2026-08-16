/**
 * n8n-side transport: sends JSON-RPC requests to the GuniWeb SAP MCP Server
 * with the credential's Bearer token and translates HTTP-level failures into
 * messages a workflow author can act on.
 */
import type {
	ICredentialDataDecryptedObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import {
	buildJsonRpcRequest,
	describeToolError,
	type McpToolInfo,
	type McpToolResult,
	parseMcpBody,
} from './mcp';

export const CREDENTIAL_NAME = 'guniwebSapApi';

type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

interface FullResponse {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

function mcpUrl(credentials: ICredentialDataDecryptedObject): string {
	const base = String(credentials.serverUrl ?? '').trim();
	const withoutSlash = base.replace(/\/+$/, '');
	return withoutSlash.endsWith('/mcp') ? withoutSlash : `${withoutSlash}/mcp`;
}

/** One JSON-RPC round trip. Throws NodeApiError/NodeOperationError on failure. */
export async function mcpRequest(
	this: Ctx,
	method: string,
	params?: Record<string, unknown>,
	itemIndex?: number,
): Promise<unknown> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	if (!String(credentials.serverUrl ?? '').trim()) {
		throw new NodeOperationError(this.getNode(), 'The credential has no server URL.', {
			itemIndex,
		});
	}
	const url = mcpUrl(credentials);
	const options: IHttpRequestOptions = {
		method: 'POST',
		url,
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify(buildJsonRpcRequest(method, params)),
		json: false,
		encoding: 'text',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: Number(credentials.timeoutMs ?? 120000) || 120000,
	};

	let response: FullResponse;
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as FullResponse;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as never, {
			message: `Cannot reach the SAP MCP Server at ${url}`,
			description:
				'Check the server URL in the credential (e.g. http://sap-mcp:8808 inside Docker) and that the server runs with --transport http.',
			itemIndex,
		});
	}

	if (response.statusCode === 401) {
		throw new NodeOperationError(
			this.getNode(),
			'The SAP MCP Server rejected the token (401 Unauthorized).',
			{
				description:
					'The Bearer token in the credential is unknown, revoked or missing. Issue a new one on the server (guniweb-sap-mcp tokens issue <destination> or POST /admin/tokens) and update the credential.',
				itemIndex,
			},
		);
	}
	if (response.statusCode === 429) {
		const retry = response.headers?.['retry-after'];
		throw new NodeOperationError(
			this.getNode(),
			'The SAP MCP Server is rate-limiting this address (429).',
			{
				description: `Too many failed authentications from this client. Retry after ${retry ?? 'a minute'} seconds and check the token.`,
				itemIndex,
			},
		);
	}
	if (response.statusCode === 503) {
		throw new NodeOperationError(
			this.getNode(),
			'The SAP MCP Server has no destination for this request (503).',
			{
				description:
					'The server runs with several destinations but none is named "default" and the token selects none. Use a token bound to a destination.',
				itemIndex,
			},
		);
	}
	if (response.statusCode === 404) {
		throw new NodeOperationError(this.getNode(), `MCP endpoint not found at ${url} (404).`, {
			description:
				'The server URL should point at the server root or its /mcp endpoint, e.g. http://sap-mcp:8808. Legacy SSE mode (--transport sse) is not supported by this node.',
			itemIndex,
		});
	}
	if (response.statusCode >= 400) {
		throw new NodeOperationError(
			this.getNode(),
			`The SAP MCP Server answered HTTP ${response.statusCode}.`,
			{ description: bodyPreview(response.body), itemIndex },
		);
	}

	const parsed = parseMcpBody(response.body);
	if (!parsed.ok) {
		throw new NodeOperationError(this.getNode(), parsed.reason, {
			description: bodyPreview(parsed.details ?? response.body),
			itemIndex,
		});
	}
	const message = parsed.value;
	if (message.error) {
		throw new NodeOperationError(
			this.getNode(),
			`MCP error ${message.error.code}: ${message.error.message}`,
			{
				description:
					message.error.data !== undefined ? JSON.stringify(message.error.data) : undefined,
				itemIndex,
			},
		);
	}
	return message.result;
}

/** `tools/list` → tool descriptors (paged; follows nextCursor). */
export async function listTools(this: Ctx): Promise<McpToolInfo[]> {
	const tools: McpToolInfo[] = [];
	let cursor: string | undefined;
	do {
		const result = (await mcpRequest.call(this, 'tools/list', cursor ? { cursor } : undefined)) as
			| { tools?: McpToolInfo[]; nextCursor?: string }
			| undefined;
		tools.push(...(result?.tools ?? []));
		cursor = result?.nextCursor;
	} while (cursor);
	return tools;
}

/**
 * `tools/call`. Throws NodeOperationError when the tool reports `isError`
 * (the SAP MCP Server puts the SAP error, hint and next step into the text).
 */
export async function callTool(
	this: Ctx,
	name: string,
	args: Record<string, unknown>,
	itemIndex?: number,
	options: { tolerateError?: boolean } = {},
): Promise<McpToolResult> {
	const result = (await mcpRequest.call(
		this,
		'tools/call',
		{ name, arguments: args },
		itemIndex,
	)) as McpToolResult;
	// Diagnostic tools (test-connection) report a failed check as isError —
	// for the workflow that is a result to look at, not a crash.
	if (result?.isError && !options.tolerateError) {
		const { message, details } = describeToolError(result);
		throw new NodeOperationError(this.getNode(), `${name}: ${message}`, {
			description: typeof details === 'string' ? details : JSON.stringify(details, null, 2),
			itemIndex,
		});
	}
	return result;
}

function bodyPreview(body: unknown): string | undefined {
	if (body === undefined || body === null) return undefined;
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
