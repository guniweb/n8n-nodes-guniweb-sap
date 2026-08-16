<img src="https://raw.githubusercontent.com/guniweb/n8n-nodes-guniweb-sap/main/icons/guniweb-sap.svg" width="88" height="88" align="right" alt="GuniWeb SAP node icon">

# n8n-nodes-guniweb-sap

SAP S/4HANA and SAP ECC as **deterministic workflow steps** in [n8n](https://n8n.io/) — query, read, create, update and delete OData entities (V2 and V4), call function imports and actions, run `$batch` requests, and send or track **IDocs over HTTP/XML** — no RFC SDK, no middleware, no AI agent required.

The node is a thin, dependency-free client for the [**GuniWeb SAP MCP Server**](https://github.com/guniweb/guniweb-sap-mcp) (`npm i -g guniweb-sap-mcp`, free to use). The server holds the SAP connections and credentials; n8n holds only an access token. One server can serve several SAP systems and several n8n workflows, each with its own token and permissions (read-only, tool tiers).

Why a node when n8n already has an MCP Client? The MCP Client node lives inside AI Agents. This node makes the same SAP operations available as **regular nodes** — the workflow author decides which operation runs with which parameters, results arrive as items, and there is no LLM in the loop unless you attach the node to an agent as a tool (it is `usableAsTool`). That is the setup we recommend for SAP: AI-assisted, human-governed workflows.

[Installation](#installation) · [Prerequisites](#prerequisites) · [Credentials](#credentials) · [Operations](#operations) · [Usage](#usage) · [Compatibility](#compatibility) · [Resources](#resources) · [Support](#support) · [Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. Package name: `n8n-nodes-guniweb-sap`.

## Prerequisites

A running GuniWeb SAP MCP Server in HTTP mode, reachable from n8n — typically as a container next to n8n:

```bash
npx guniweb-sap-mcp --transport http --port 8808 --destinations /config/destinations.json
# issue a token for the SAP system the workflows should use:
guniweb-sap-mcp tokens issue s4prod --label "n8n prod" [--read-only] [--tiers core,odata]
```

The token is printed once; put it into the n8n credential (below). Server setup, `destinations.json`, tokens and the optional Admin API are documented in the [server's setup guide](https://github.com/guniweb/guniweb-sap-mcp/blob/main/docs/setup-guide.md). Write operations (create/update/delete/function/batch/IDoc send) additionally require the server to run with `--allow-write` and a token that is not `read-only`; IDoc operations require the `idoc` tier.

## Credentials

**GuniWeb SAP MCP Server API**

| Field | Meaning |
|---|---|
| Server URL | Base URL of the server, e.g. `http://sap-mcp:8808` inside Docker or `https://sap-mcp.example.com`. `/mcp` is added automatically. |
| Access Token | The Bearer token issued on the server (`tokens issue` or `POST /admin/tokens`). It authenticates the request **and** selects the SAP system. |
| SAP User / SAP Password | **Personal SAP login** — only for destinations the server runs with `authType: "user-basic"`: your own SAP credentials travel with every call and are used for that call only; SAP authorizations and change documents are on you. Leave empty when the destination uses a technical SAP user. |
| Request Timeout | Per call, default 120 s — keep it above the server's tool timeout (default 30 s). |

"Test credential" performs a `tools/list` round trip: 200 = URL and token are right (and, for `user-basic`, the SAP login was sent), 401 = token rejected or SAP login missing, connection error = URL or transport wrong. Whether SAP accepts the personal login is what *Discovery → Test Connection* tells you.

**Two ways to act in SAP.** With a technical user (destination `authType: "basic"`, `oauth2`, …) the server holds the SAP credentials and every workflow acts as that user. With the personal login (`user-basic`) every person acts as themselves — the recommended setup when several people build workflows against one system. German step-by-step guides: [für Anwender](docs/anleitung-mitarbeiter.md) · [für Administratoren](docs/anleitung-admin.md).

## Operations

| Resource | Operation | Server tool | Notes |
|---|---|---|---|
| **OData** | Query | `sap_query` | `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`; one item per row by default |
| | Read | `sap_read` | one entity by key (JSON object) |
| | Create | `sap_create` | deep insert via nested navigation properties |
| | Update | `sap_update` | ETag/CSRF handled by the server |
| | Delete | `sap_delete` | |
| | Call Function | `sap_function` | V2 function imports, V4 actions/functions (bound and unbound) |
| | Batch | `sap_batch` | several operations in one `$batch` |
| **Discovery** | Test Connection | `test-connection` | DNS → TLS → auth → client → catalog; a failed stage is returned as data, not thrown |
| | Discover Services | `sap_discover_services` | search + business category, one item per service |
| | List Entity Sets | `sap_list_services` | one item per entity set |
| | Get Metadata | `sap_get_metadata` | entity types, keys, properties, navigations |
| **IDoc** | Send | `sap_idoc_send` | segments as JSON, control record built by the server |
| | Get Status | `sap_idoc_status` | |
| | Discover Types | `sap_idoc_discover` | |
| | List Received | `sap_idoc_list_received` | IDocs SAP posted to the server's `/idoc` webhook |
| **Tool** | List Tools | `tools/list` | what this token may use, with input schemas |
| | Call Tool | `tools/call` | any tool by name with raw JSON arguments — the escape hatch for RFC/BAPI, NL query and future tools |

Errors from SAP arrive as node errors with the server's message, hint and next step; with *Continue On Fail* they become `{ error }` items.

## Usage

**Read business partners from Germany, one item each:**

- Resource *OData*, Operation *Query*
- Service URL `/sap/opu/odata/sap/API_BUSINESS_PARTNER`, Entity Set `A_BusinessPartner`
- Query Options → Filter `Country eq 'DE'`, Select `BusinessPartner,BusinessPartnerName`, Top `100`

**Create a sales order with items (deep insert):**

- Resource *OData*, Operation *Create*, Service URL `/sap/opu/odata/sap/API_SALES_ORDER_SRV`, Entity Set `A_SalesOrder`
- Data:

```json
{
  "SalesOrderType": "OR",
  "SalesOrganization": "1010",
  "DistributionChannel": "10",
  "OrganizationDivision": "00",
  "SoldToParty": "{{ $json.customer }}",
  "to_Item": [
    { "Material": "{{ $json.material }}", "RequestedQuantity": "{{ $json.qty }}" }
  ]
}
```

Requires the server to run with `--allow-write` and a token without `readOnly`. Before automating document creation, settle the two questions the server documentation raises (write governance and SAP Digital Access) with your SAP team.

**Anything else:** Resource *Tool* → *List Tools* shows what the server exposes for your token, *Call Tool* runs it with raw JSON arguments.

## Development

```bash
npm install
npm run lint && npm test && npm run build
# smoke run against a real server:
SAP_MCP_URL=http://localhost:8808 SAP_MCP_TOKEN=gsm_… node scripts/smoke-real-server.mjs
```

## Compatibility

Built and linted with `@n8n/node-cli` against n8n `2.x` (`n8n-workflow` peer dependency, `n8nNodesApiVersion: 1`). Requires GuniWeb SAP MCP Server ≥ 0.3.0 in HTTP transport (`--transport http`), ≥ 0.4.0 for the personal SAP login (`user-basic`); the legacy SSE transport is not supported. No runtime dependencies.

## Resources

- [GuniWeb SAP MCP Server — documentation, releases, issues](https://github.com/guniweb/guniweb-sap-mcp)
- [Server tool reference (all parameters and responses)](https://github.com/guniweb/guniweb-sap-mcp/blob/main/docs/api-reference.md)
- [Which SAP interfaces the server uses, and how it behaves](https://github.com/guniweb/guniweb-sap-mcp/blob/main/docs/sap-interfaces.md)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Support

Community: [issues](https://github.com/guniweb/n8n-nodes-guniweb-sap/issues) in this repository (node) or in the [server repository](https://github.com/guniweb/guniweb-sap-mcp/issues) (SAP behaviour). Commercial support, production SLAs and implementation: [guniweb.de/sap-mcp](https://guniweb.de/sap-mcp) · support@guniweb.de.

## Version history

- **0.1.0** — first release: OData (query/read/create/update/delete/function/batch), Discovery, IDoc, generic Tool resource; credential with connection test and optional personal SAP login (`user-basic` destinations).

## License

MIT — see [LICENSE.md](LICENSE.md). SAP and S/4HANA are trademarks of SAP SE; this project is not affiliated with SAP SE.
