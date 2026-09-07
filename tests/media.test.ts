/**
 * Die beiden Media-Operationen des Knotens, gegen einen Server-Ersatz im
 * selben Prozess. Geprüft wird, was der Knoten schickt (Binärfeld → base64,
 * Dateiname, Content-Type, Kopfzeilen) und was er zurückgibt (Bytes als
 * Binärfeld, nicht als base64-Zeichenkette im JSON).
 *
 * Ohne diese Betriebsart muss ein Anhang über HTTP-Request-Knoten laufen, und
 * Zertifikatskette, CSRF-Vorlauf und Fehlereinordnung sind dort neu zu bauen.
 */
import type { IHttpRequestOptions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { GuniwebSap } from '../nodes/GuniwebSap/GuniwebSap.node';

const PDF = Buffer.from('%PDF-1.7 Auftragsbestätigung');

/** Was der Server-Ersatz beim letzten tools/call gesehen hat. */
interface Seen {
	name: string;
	args: Record<string, unknown>;
}

interface ContextOptions {
	operation: 'uploadMedia' | 'downloadMedia';
	parameters: Record<string, unknown>;
	binary?: { fileName?: string; mimeType?: string; data?: Buffer };
	seen: Seen[];
}

function fakeContext(options: ContextOptions) {
	const prepared: Array<{ data: Buffer; fileName?: string; mimeType?: string }> = [];

	const context = {
		getInputData: () => [{ json: {} }],
		continueOnFail: () => false,
		getNode: () => ({
			name: 'GuniWeb SAP',
			type: 'guniwebSap',
			typeVersion: 1,
			position: [0, 0] as [number, number],
			parameters: {},
		}),
		getCredentials: async () => ({ serverUrl: 'http://sap-mcp.test:8808', token: 'gsm_t' }),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => {
			if (name === 'resource') return 'odata';
			if (name === 'operation') return options.operation;
			return name in options.parameters ? options.parameters[name] : fallback;
		},
		helpers: {
			assertBinaryData: (_i: number, field: string) => {
				if (!options.binary) throw new Error(`no binary data on field ${field}`);
				return { fileName: options.binary.fileName, mimeType: options.binary.mimeType };
			},
			getBinaryDataBuffer: async () => options.binary?.data ?? PDF,
			prepareBinaryData: async (data: Buffer, fileName?: string, mimeType?: string) => {
				prepared.push({ data, fileName, mimeType });
				return { data: data.toString('base64'), fileName, mimeType, fileSize: `${data.length}` };
			},
			async httpRequestWithAuthentication(_cred: string, request: IHttpRequestOptions) {
				const rpc = JSON.parse(String(request.body)) as {
					params: { name: string; arguments: Record<string, unknown> };
				};
				options.seen.push({ name: rpc.params.name, args: rpc.params.arguments });
				return {
					statusCode: 200,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: answerFor(rpc.params.name) }),
				};
			},
		},
	};

	return { context: context as never, prepared };
}

function answerFor(tool: string) {
	if (tool === 'sap_media_upload') {
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						uploaded: {
							status: 201,
							slug: 'auftrag.pdf',
							bytesSent: PDF.length,
							entity: { DocumentInfoRecordDocNumber: '10000042' },
						},
					}),
				},
			],
		};
	}
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify({
					status: 200,
					fileName: 'auftrag.pdf',
					contentType: 'application/pdf',
					bytes: PDF.length,
				}),
			},
			{
				type: 'resource',
				resource: {
					uri: 'sap://AttachmentContentSet/auftrag.pdf',
					mimeType: 'application/pdf',
					blob: PDF.toString('base64'),
				},
			},
		],
	};
}

describe('Upload Media', () => {
	const baseParameters = {
		serviceUrl: '/sap/opu/odata/sap/API_CV_ATTACHMENT_SRV',
		entitySet: 'AttachmentContentSet',
		binaryPropertyName: 'data',
		jsonHeaders: '{"BusinessObjectTypeName":"BUS2032","LinkedSAPObjectKey":"0000012345"}',
		uploadOptions: {},
	};

	it('sends the binary field as base64 with name and type from the metadata', async () => {
		const seen: Seen[] = [];
		const { context } = fakeContext({
			operation: 'uploadMedia',
			parameters: baseParameters,
			binary: { fileName: 'auftrag.pdf', mimeType: 'application/pdf' },
			seen,
		});

		const out = await new GuniwebSap().execute.call(context);

		expect(seen[0].name).toBe('sap_media_upload');
		expect(seen[0].args).toMatchObject({
			serviceUrl: '/sap/opu/odata/sap/API_CV_ATTACHMENT_SRV',
			entitySet: 'AttachmentContentSet',
			contentBase64: PDF.toString('base64'),
			fileName: 'auftrag.pdf',
			contentType: 'application/pdf',
			headers: { BusinessObjectTypeName: 'BUS2032', LinkedSAPObjectKey: '0000012345' },
		});
		expect(out[0][0].json).toMatchObject({ uploaded: { status: 201 } });
	});

	it('lets the options override name and content type', async () => {
		const seen: Seen[] = [];
		const { context } = fakeContext({
			operation: 'uploadMedia',
			parameters: {
				...baseParameters,
				uploadOptions: { fileName: 'anders.pdf', contentType: 'application/x-pdf' },
			},
			binary: { fileName: 'auftrag.pdf', mimeType: 'application/pdf' },
			seen,
		});

		await new GuniwebSap().execute.call(context);

		expect(seen[0].args).toMatchObject({
			fileName: 'anders.pdf',
			contentType: 'application/x-pdf',
		});
	});

	// Ohne Dateinamen fehlt SAP der Slug — das soll der Knoten sagen, statt
	// den Aufruf ohne ihn abzuschicken.
	it('refuses a binary field without a file name', async () => {
		const seen: Seen[] = [];
		const { context } = fakeContext({
			operation: 'uploadMedia',
			parameters: baseParameters,
			binary: { mimeType: 'application/pdf' },
			seen,
		});

		await expect(new GuniwebSap().execute.call(context)).rejects.toThrow(/Dateinamen/);
		expect(seen).toHaveLength(0);
	});

	it('sends no headers at all when the field is empty', async () => {
		const seen: Seen[] = [];
		const { context } = fakeContext({
			operation: 'uploadMedia',
			parameters: { ...baseParameters, jsonHeaders: '' },
			binary: { fileName: 'auftrag.pdf', mimeType: 'application/pdf' },
			seen,
		});

		await new GuniwebSap().execute.call(context);

		expect(seen[0].args).not.toHaveProperty('headers');
	});
});

describe('Download Media', () => {
	const parameters = {
		serviceUrl: '/sap/opu/odata/sap/API_CV_ATTACHMENT_SRV',
		entitySet: 'AttachmentContentSet',
		key: '{"DocumentInfoRecordDocNumber":"10000042"}',
		binaryPropertyName: 'anhang',
		downloadOptions: {},
	};

	it('puts the bytes into a binary field, not into json', async () => {
		const seen: Seen[] = [];
		const { context, prepared } = fakeContext({ operation: 'downloadMedia', parameters, seen });

		const out = await new GuniwebSap().execute.call(context);

		expect(seen[0].name).toBe('sap_media_download');
		expect(seen[0].args).toMatchObject({ key: { DocumentInfoRecordDocNumber: '10000042' } });

		// Die Bytes gehen unverändert ins Binärfeld …
		expect(prepared[0].data).toEqual(PDF);
		expect(prepared[0].fileName).toBe('auftrag.pdf');
		expect(prepared[0].mimeType).toBe('application/pdf');
		expect(out[0][0].binary).toHaveProperty('anhang');

		// … und im JSON stehen nur die Angaben dazu, kein base64.
		expect(out[0][0].json).toMatchObject({ fileName: 'auftrag.pdf', bytes: PDF.length });
		expect(JSON.stringify(out[0][0].json)).not.toContain(PDF.toString('base64'));
	});

	it('passes the option to skip the $value path', async () => {
		const seen: Seen[] = [];
		const { context } = fakeContext({
			operation: 'downloadMedia',
			parameters: { ...parameters, downloadOptions: { withoutValuePath: true } },
			seen,
		});

		await new GuniwebSap().execute.call(context);

		expect(seen[0].args).toMatchObject({ withoutValuePath: true });
	});
});
