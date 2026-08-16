import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { compact, parseJsonParameter, splitList, toolResultToData } from './mcp';
import { callTool, CREDENTIAL_NAME, listTools } from './transport';
import { properties } from './properties';

/**
 * GuniWeb SAP — deterministic SAP steps for n8n workflows.
 *
 * A thin wrapper around the tools of a running GuniWeb SAP MCP Server: every
 * operation is one `tools/call`. The workflow author decides which operation
 * runs with which parameters; no LLM is involved unless you attach the node
 * to an AI Agent as a tool (usableAsTool).
 */
export class GuniwebSap implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GuniWeb SAP',
		name: 'guniwebSap',
		icon: { light: 'file:../../icons/guniweb-sap.svg', dark: 'file:../../icons/guniweb-sap.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'SAP S/4HANA and ECC via the GuniWeb SAP MCP Server: OData query/read/create/update/delete, function imports, batch, IDoc over HTTP/XML',
		defaults: {
			name: 'GuniWeb SAP',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		properties,
	};

	methods = {
		loadOptions: {
			async getTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const tools = await listTools.call(this);
				return tools
					.map((t) => ({
						name: t.title ? `${t.title} (${t.name})` : t.name,
						value: t.name,
						description: (t.description ?? '').split('\n')[0].slice(0, 200),
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const out = await runOperation.call(this, resource, operation, i);
				for (const json of out) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: i },
					});
					continue;
				}
				const description = (error as { description?: string })?.description;
				throw new NodeOperationError(this.getNode(), error as Error, {
					itemIndex: i,
					description,
				});
			}
		}
		return [returnData];
	}
}

/** Runs one operation for one input item and returns the output items. */
async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<IDataObject[]> {
	const str = (name: string, fallback = ''): string =>
		String(this.getNodeParameter(name, i, fallback) ?? '');
	const bool = (name: string): boolean => this.getNodeParameter(name, i, false) === true;
	const json = (name: string, raw?: unknown): unknown => {
		const outcome = parseJsonParameter(raw ?? this.getNodeParameter(name, i, ''), name);
		if (!outcome.ok) {
			throw new NodeOperationError(this.getNode(), outcome.reason, {
				description: typeof outcome.details === 'string' ? outcome.details : undefined,
				itemIndex: i,
			});
		}
		return outcome.value;
	};
	const jsonString = (name: string): string | undefined => {
		const value = json(name);
		return value === undefined ? undefined : JSON.stringify(value);
	};
	const call = async (tool: string, args: Record<string, unknown>, tolerateError = false) =>
		toolResultToData(await callTool.call(this, tool, compact(args), i, { tolerateError }));

	// -----------------------------------------------------------------------
	if (resource === 'odata') {
		const serviceUrl = str('serviceUrl');
		switch (operation) {
			case 'query': {
				const options = this.getNodeParameter('queryOptions', i, {}) as IDataObject;
				const data = await call('sap_query', {
					serviceUrl,
					entitySet: str('entitySet'),
					filter: options.filter,
					select: splitList(options.select),
					expand: splitList(options.expand),
					orderby: options.orderby,
					top: options.top,
					skip: options.skip,
					maxPages: options.maxPages,
				});
				if (bool('splitResults') && data && typeof data === 'object') {
					const results = (data as { results?: unknown }).results;
					if (Array.isArray(results)) return results.map((r) => asObject(r));
				}
				return [asObject(data)];
			}
			case 'read': {
				const options = this.getNodeParameter('readOptions', i, {}) as IDataObject;
				return [
					asObject(
						await call('sap_read', {
							serviceUrl,
							entitySet: str('entitySet'),
							key: json('key'),
							select: splitList(options.select),
							expand: splitList(options.expand),
						}),
					),
				];
			}
			case 'create':
				return [
					asObject(
						await call('sap_create', {
							serviceUrl,
							entitySet: str('entitySet'),
							data: jsonString('data'),
						}),
					),
				];
			case 'update':
				return [
					asObject(
						await call('sap_update', {
							serviceUrl,
							entitySet: str('entitySet'),
							key: jsonString('key'),
							data: jsonString('data'),
						}),
					),
				];
			case 'delete':
				return [
					asObject(
						await call('sap_delete', {
							serviceUrl,
							entitySet: str('entitySet'),
							key: jsonString('key'),
						}),
					),
				];
			case 'function': {
				const options = this.getNodeParameter('functionOptions', i, {}) as IDataObject;
				return [
					asObject(
						await call('sap_function', {
							serviceUrl,
							functionName: str('functionName'),
							parameters: json('parameters'),
							httpMethod: options.httpMethod,
							isFunction: options.isFunction,
							entitySet: options.entitySet,
							key: json('key', options.key),
						}),
					),
				];
			}
			case 'batch':
				return [asObject(await call('sap_batch', { serviceUrl, operations: json('operations') }))];
		}
	}

	// -----------------------------------------------------------------------
	if (resource === 'discovery') {
		switch (operation) {
			case 'testConnection':
				// A failed diagnosis is the result the workflow wants to branch on.
				return [asObject(await call('test-connection', {}, true))];
			case 'discoverServices': {
				const options = this.getNodeParameter('discoverOptions', i, {}) as IDataObject;
				const data = await call('sap_discover_services', {
					search: options.search,
					category: options.category,
					limit: options.limit,
					offset: options.offset,
				});
				return listOrObject(data, 'services');
			}
			case 'listServices': {
				const options = this.getNodeParameter('listOptions', i, {}) as IDataObject;
				const data = await call('sap_list_services', {
					serviceUrl: str('serviceUrl'),
					top: options.top,
					skip: options.skip,
				});
				return listOrObject(data, 'entitySets', 'entitySet');
			}
			case 'getMetadata': {
				const options = this.getNodeParameter('metadataOptions', i, {}) as IDataObject;
				return [
					asObject(
						await call('sap_get_metadata', {
							serviceUrl: str('serviceUrl'),
							entityType: options.entityType,
							search: options.search,
						}),
					),
				];
			}
		}
	}

	// -----------------------------------------------------------------------
	if (resource === 'idoc') {
		switch (operation) {
			case 'send': {
				const options = this.getNodeParameter('idocOptions', i, {}) as IDataObject;
				return [
					asObject(
						await call('sap_idoc_send', {
							idocType: str('idocType'),
							segments: json('segments'),
							metadataServiceUrl: options.metadataServiceUrl,
							mesType: options.mesType,
							sndpor: options.sndpor,
							sndprn: options.sndprn,
							rcvpor: options.rcvpor,
							rcvprn: options.rcvprn,
						}),
					),
				];
			}
			case 'status':
				return [
					asObject(
						await call('sap_idoc_status', {
							docnum: str('docnum'),
							statusServiceUrl: str('statusServiceUrl'),
						}),
					),
				];
			case 'discover':
				return [
					asObject(
						await call('sap_idoc_discover', { metadataServiceUrl: str('metadataServiceUrl') }),
					),
				];
			case 'listReceived': {
				const data = await call('sap_idoc_list_received', {});
				return listOrObject(data, 'idocs');
			}
		}
	}

	// -----------------------------------------------------------------------
	if (resource === 'tool') {
		switch (operation) {
			case 'list': {
				const tools = await listTools.call(this);
				return tools.map((t) => asObject(t));
			}
			case 'call': {
				const args = json('arguments');
				if (args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
					throw new NodeOperationError(this.getNode(), 'Arguments must be a JSON object.', {
						itemIndex: i,
					});
				}
				const data = await call(str('toolName'), (args as Record<string, unknown>) ?? {});
				return Array.isArray(data) ? data.map((d) => asObject(d)) : [asObject(data)];
			}
		}
	}

	throw new NodeOperationError(
		this.getNode(),
		`Unsupported operation "${operation}" for resource "${resource}".`,
		{ itemIndex: i },
	);
}

function asObject(value: unknown): IDataObject {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return value as IDataObject;
	}
	return { data: value as never };
}

/**
 * Lists that the server wraps in an object: one item per entry when present.
 * Plain string entries (e.g. entity set names) become `{ [itemKey]: entry }`.
 */
function listOrObject(data: unknown, key: string, itemKey = 'value'): IDataObject[] {
	const toItem = (entry: unknown): IDataObject =>
		typeof entry === 'string' ? { [itemKey]: entry } : asObject(entry);
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const list = (data as Record<string, unknown>)[key];
		if (Array.isArray(list)) return list.map(toItem);
	}
	if (Array.isArray(data)) return data.map(toItem);
	return [asObject(data)];
}
