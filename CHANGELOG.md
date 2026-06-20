# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9: DataCanvas describe() binder-error fix, SQL-gate invalid_sql classification, ctx.content collector, two new devcheck guards (dependency specifiers, plugin-manifest correctness).

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-06-15

Adopt @cyanheads/mcp-ts-core ^0.10.6: server identity name/title, Docker HEALTHCHECK + image.version label, bundle cleaner for dependency-shipped agent docs, packaging/antipattern lint additions.

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-04

Populate data.recovery.hint via ctx.fail in all four tool handlers — agents now get actionable next-step guidance on every declared error path

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.16 → ^0.9.21 — per-request log context fix, secret-stripping in fetch errors, withRetry fail-fast; skill sync (api-mirror, orchestrations, 8 updated)

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-30

Enrichment adoption — search/browse/query tools surface query echoes, result totals, and empty-result guidance via typed enrichment block; mcp-ts-core ^0.9.13 → ^0.9.16

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-28

mcp-ts-core ^0.9.9 → ^0.9.13: 413 body cap, session-init gate, quieter expected-error logs, GET /mcp keywords; skill sync, plugin metadata scaffolding

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Code simplification, error code corrections (InvalidParams → ValidationError), mcp-ts-core ^0.9.7 → ^0.9.9, skills synced

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-24

Four field-test bug fixes: obs cap (355MB crash), conflicting param validation, notFound reason field, dataStart/dataEnd whitespace

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Added hosted server endpoint: remotes block in server.json pointing to https://eurostat.caseyjhand.com/mcp

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Metadata alignment: Dockerfile restored to oven/bun:1.3, package.json scripts/fields, manifest.json fields, server.json env vars, CLAUDE.md + AGENTS.md, vitest.config.ts simplified

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Sync tagline across README, package.json, server.json, and manifest.json

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-24

Bug fixes: depth-encoding whitespace in browse_themes, timeRange computed from observations, not_found error contract, description cleanup

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

First public release — 5 tools, 1 resource, full Eurostat implementation covering 8,900+ datasets and NUTS regional data

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — Eurostat statistical data server with 5 tools and 1 resource
