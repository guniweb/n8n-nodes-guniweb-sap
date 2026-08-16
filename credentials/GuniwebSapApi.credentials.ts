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
 * system (destination).
 *
 * Two ways to act in SAP:
 * - Technical user: the destination on the server holds the SAP credentials;
 *   the credential here carries only the token.
 * - Personal SAP login (destination `authType: user-basic`): SAP user and
 *   password of the person are entered here and travel with every request as
 *   X-SAP-Username / X-SAP-Password — SAP authorizations, change documents
 *   and audit trail on the real user, nothing stored on the server.
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
			displayName: 'SAP User',
			name: 'sapUsername',
			type: 'string',
			default: '',
			description:
				'Your personal SAP user — only for destinations the server runs with authType user-basic (personal SAP login per request). Leave empty when the server uses a technical SAP user.',
		},
		{
			displayName: 'SAP Password',
			name: 'sapPassword',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Your personal SAP password. Sent to the server as X-SAP-Password with every call and used for that call only; never stored on the server.',
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
	// rejected (or, for a user-basic destination, SAP user/password missing),
	// connection errors = URL/transport wrong. Whether SAP accepts the personal
	// login is checked by the node's "Test Connection" operation.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl.replace(/\\/+$/, "").replace(/\\/mcp$/, "")}}',
			url: '/mcp',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'X-SAP-Username': '={{$credentials.sapUsername || ""}}',
				'X-SAP-Password': '={{$credentials.sapPassword || ""}}',
			},
			body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
			json: false,
		},
	};
}
