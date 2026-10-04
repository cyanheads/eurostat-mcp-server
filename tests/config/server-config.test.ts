/**
 * @fileoverview Tests for the server's environment configuration — defaults,
 * parsing, and the error a bad value raises.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A fresh module per read: `getServerConfig` memoizes the first successful
 * parse, so each case has to import it after its environment is in place.
 */
async function loadConfig() {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('applies the documented defaults when nothing is set', async () => {
    for (const name of [
      'EUROSTAT_BASE_URL',
      'EUROSTAT_COMEXT_BASE_URL',
      'EUROSTAT_REQUEST_TIMEOUT_MS',
      'EUROSTAT_METADATA_TIMEOUT_MS',
      'EUROSTAT_TOC_CACHE_TTL_MS',
      'EUROSTAT_BULK_TIMEOUT_MS',
      'EUROSTAT_BULK_MAX_BYTES',
      'EUROSTAT_DATAFRAME_DROP_ENABLED',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const config = (await loadConfig())();
    expect(config).toEqual({
      baseUrl: 'https://ec.europa.eu/eurostat/api/dissemination',
      comextBaseUrl: 'https://ec.europa.eu/eurostat/api/comext/dissemination',
      requestTimeoutMs: 30_000,
      metadataTimeoutMs: 120_000,
      tocCacheTtlMs: 43_200_000,
      bulkTimeoutMs: 120_000,
      bulkMaxBytes: 52_428_800,
      dataframeDropEnabled: false,
    });
  });

  describe('EUROSTAT_DATAFRAME_DROP_ENABLED', () => {
    // `false` has to parse as false: a coerced boolean would read the string "false" as true.
    for (const [raw, expected] of [
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['off', false],
      // A blank line in .env, or an option a host forwards unfilled, means unset.
      ['', false],
      [`\${EUROSTAT_DATAFRAME_DROP_ENABLED}`, false],
    ] as const) {
      it(`reads ${JSON.stringify(raw)} as ${expected}`, async () => {
        vi.stubEnv('EUROSTAT_DATAFRAME_DROP_ENABLED', raw);
        expect((await loadConfig())().dataframeDropEnabled).toBe(expected);
      });
    }

    it('defaults to false when unset', async () => {
      vi.stubEnv('EUROSTAT_DATAFRAME_DROP_ENABLED', undefined);
      expect((await loadConfig())().dataframeDropEnabled).toBe(false);
    });

    for (const raw of ['maybe', 'enable', '2']) {
      it(`rejects ${JSON.stringify(raw)} as a configuration error naming the variable`, async () => {
        vi.stubEnv('EUROSTAT_DATAFRAME_DROP_ENABLED', raw);
        const getServerConfig = await loadConfig();
        expect(() => getServerConfig()).toThrow(
          expect.objectContaining({
            code: JsonRpcErrorCode.ConfigurationError,
            message: expect.stringContaining('EUROSTAT_DATAFRAME_DROP_ENABLED'),
          }),
        );
      });
    }
  });

  it('reads a numeric override from its variable', async () => {
    vi.stubEnv('EUROSTAT_BULK_MAX_BYTES', '1024');
    expect((await loadConfig())().bulkMaxBytes).toBe(1024);
  });

  it('rejects a bad value as a configuration error naming the variable', async () => {
    vi.stubEnv('EUROSTAT_REQUEST_TIMEOUT_MS', 'soon');
    const getServerConfig = await loadConfig();
    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('EUROSTAT_REQUEST_TIMEOUT_MS'),
      }),
    );
  });
});
