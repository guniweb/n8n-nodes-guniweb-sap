import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Access to a running GuniWeb SAP MCP Server. The token is the Bearer value
 * issued on the server (`guniweb-sap-mcp tokens issue <destination>` or
 * `POST /admin/tokens`); it authenticates the request AND selects the SAP
 * system (destination) — SAP passwords never leave the server.
 */
export class GuniwebSapApi implements ICredentialType {
	name = 'guniwebSapApi';

	displayName = 'GuniWeb SAP MCP Server API';

	icon: Icon = { light: 'file:../icons/guniweb-sap.svg', dark: 'file:../icons/guniweb-sap.dark.svg' };

	documentationUrl = 'https://github.com/guniweb/n8n-nodes-guniweb-sap?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: 'http://sap-mcp:8808',
			placeholder: 'http://sap-mcp:8808',
			description:
				'Base URL of the GuniWeb SAP MCP Server (HTTP transport). The /mcp path is added automatically.',
			required: true,
		},
		{
			displayName: 'Access Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Bearer token issued on the server (tokens issue / POST /admin/tokens). It selects the SAP destination; leave empty only if the server runs without tokens and without --api-key.',
		},
		{
			displayName: 'Request Timeout (Ms)',
			name: 'timeoutMs',
			type: 'number',
			default: 120000,
			description:
				'How long to wait for one tool call. Keep it above the server-side tool timeout (default 30 s) and below the limits of proxies in between.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '={{$credentials.token ? "Bearer " + $credentials.token : undefined}}',
			},
		},
	};

	// A tools/list round trip: 200 means URL and token are right; 401 = token
	// rejected, connection errors = URL/transport wrong.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl.replace(/\\/+$/, "").replace(/\\/mcp$/, "")}}',
			url: '/mcp',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
			json: false,
		},
	};
}
