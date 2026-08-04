/**
 * @fileoverview Server-specific environment variable configuration for eurostat-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .default('https://ec.europa.eu/eurostat/api/dissemination')
    .describe('Eurostat API base URL'),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('HTTP request timeout in milliseconds'),
  tocCacheTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(43_200_000)
    .describe(
      'How long a fetched catalogue TOC stays usable before the next catalogue call refreshes it, in milliseconds. Defaults to 12 hours, matching the upstream twice-daily update cadence.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'EUROSTAT_BASE_URL',
    requestTimeoutMs: 'EUROSTAT_REQUEST_TIMEOUT_MS',
    tocCacheTtlMs: 'EUROSTAT_TOC_CACHE_TTL_MS',
  });
  return _config;
}
