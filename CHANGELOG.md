# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.2.0] - 2026-09-07

### Added

- **Binary payloads: *Upload Media* and *Download Media*.** The node spoke JSON only, so SAP media entities — attachments, document images, archive documents — had to go around it through an HTTP Request node. That meant rebuilding four things the node already brings: the certificate chain (an intermediate alone is not enough for Node and OpenSSL, so a root CA credential of its own), the CSRF handshake with cookie forwarding, the client parameter, and the error classification. *Upload Media* sends a binary field of the incoming item as raw bytes, with the file name as the `Slug` header; *Download Media* writes the fetched bytes into a binary field instead of leaving a base64 string in the JSON. Needs GuniWeb SAP MCP Server 0.5.0 or newer.
- **Object headers as a JSON field, not a pair list.** A pair list cannot express "leave this header out entirely" — it sends an empty value, and SAP answers that with a message that reads like a missing authorisation and is none. `Object Headers` takes a JSON object; a line that is not there is not sent.

## [0.1.1] - 2026-08-17

### Changed

- Node and credential icon: the GuniWeb logo (round orange mark with the "G", as on guniweb.de) with a small blue data cube as the SAP hint — no SAP wordmark or logo (trademark).

## [0.1.0] - 2026-08-16

### Added

- First release of the **GuniWeb SAP** node and the **GuniWeb SAP MCP Server API** credential.
- Resources: **OData** (Query, Read, Create, Update, Delete, Call Function, Batch), **Discovery** (Test Connection, Discover Services, List Entity Sets, Get Metadata), **IDoc** (Send, Get Status, Discover Types, List Received), **Tool** (List Tools, Call Tool).
- Stateless Streamable HTTP client without runtime dependencies (JSON and event-stream answers, Bearer auth, per-status error messages for 401/404/429/503, server tool errors surfaced with message, hint and next step).
- Node is usable as an AI Agent tool (`usableAsTool`).
- Credential fields **SAP User / SAP Password** for destinations with `authType: "user-basic"` (personal SAP login per request, server ≥ 0.4.0): sent as `X-SAP-Username`/`X-SAP-Password` only when both are set; 401 "SAP login required" and 400 "no personal login accepted" are explained in credential terms.
- German guides: `docs/anleitung-mitarbeiter.md` (users), `docs/anleitung-admin.md` (administrators).
