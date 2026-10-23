/**
 * @fileoverview Server-specific environment variable configuration for eurostat-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Clamp positive read limits to preview 500 and search 100 with a notice. False restores rejecting maximum schemas.',
    ),
  baseUrl: z
    .string()
    .url()
    .default('https://ec.europa.eu/eurostat/api/dissemination')
    .describe('Eurostat API base URL'),
  comextBaseUrl: z
    .string()
    .url()
    .default('https://ec.europa.eu/eurostat/api/comext/dissemination')
    .describe(
      'Base URL of the Comext dissemination host, which serves the DS-* collections (detailed trade and PRODCOM) the main host does not. Every dataset code starting "DS-", in any case, is routed here.',
    ),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe(
      'Total allowance for one Eurostat request, including retries, backoff and body consumption, in milliseconds',
    ),
  metadataTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000)
    .describe(
      "Total allowance for one dataset's SDMX dataflow structure, including retries, backoff and body consumption, in milliseconds. Held separate from EUROSTAT_REQUEST_TIMEOUT_MS because the structure carries a label for every code the dataset uses: 23 MB, uncompressed, for the CN8 trade collection DS-045409. Defaults to 2 minutes.",
    ),
  tocCacheTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(43_200_000)
    .describe(
      'How long a fetched catalogue TOC stays usable before the next catalogue call refreshes it, in milliseconds. Defaults to 12 hours, matching the upstream twice-daily update cadence.',
    ),
  bulkTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000)
    .describe(
      'Total allowance for one SDMX bulk download, including request retries, backoff and streaming body consumption, in milliseconds. Held separate from EUROSTAT_REQUEST_TIMEOUT_MS because a bulk body can take longer than a metadata call. Defaults to 2 minutes.',
    ),
  bulkMaxBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(52_428_800)
    .describe(
      'Byte budget for one SDMX bulk download, measured on the decoded TSV rather than on the wire. Eurostat sends the body chunked with no Content-Length, so the budget is enforced while streaming and the transfer is aborted the moment it is reached. Defaults to 50 MiB.',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Register eurostat_dataframe_drop, which removes one staged table from a dataframe canvas. Off by default: a drop cannot be undone, and staged tables already expire with their canvas. Has no effect with CANVAS_PROVIDER_TYPE=none.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    clampLimits: 'EUROSTAT_CLAMP_LIMITS',
    baseUrl: 'EUROSTAT_BASE_URL',
    comextBaseUrl: 'EUROSTAT_COMEXT_BASE_URL',
    requestTimeoutMs: 'EUROSTAT_REQUEST_TIMEOUT_MS',
    metadataTimeoutMs: 'EUROSTAT_METADATA_TIMEOUT_MS',
    tocCacheTtlMs: 'EUROSTAT_TOC_CACHE_TTL_MS',
    bulkTimeoutMs: 'EUROSTAT_BULK_TIMEOUT_MS',
    bulkMaxBytes: 'EUROSTAT_BULK_MAX_BYTES',
    dataframeDropEnabled: 'EUROSTAT_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
