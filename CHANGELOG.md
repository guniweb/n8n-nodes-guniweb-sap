# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.1.0] - 2026-08-16

### Added

- First release of the **GuniWeb SAP** node and the **GuniWeb SAP MCP Server API** credential.
- Resources: **OData** (Query, Read, Create, Update, Delete, Call Function, Batch), **Discovery** (Test Connection, Discover Services, List Entity Sets, Get Metadata), **IDoc** (Send, Get Status, Discover Types, List Received), **Tool** (List Tools, Call Tool).
- Stateless Streamable HTTP client without runtime dependencies (JSON and event-stream answers, Bearer auth, per-status error messages for 401/404/429/503, server tool errors surfaced with message, hint and next step).
- Node is usable as an AI Agent tool (`usableAsTool`).
