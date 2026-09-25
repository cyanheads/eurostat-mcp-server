/**
 * @fileoverview Which Eurostat host serves a dataset. Every service that builds a
 * dataset-scoped URL asks here, so the routing rule lives in one place.
 * @module services/eurostat-hosts
 */

import { getServerConfig } from '@/config/server-config.js';

/**
 * True for a `DS-*` code — the detailed trade (Comext) and PRODCOM collections.
 *
 * The Comext dissemination host serves exactly these, and the main host serves none
 * of them: its 8,149 dataflow ids are letters, digits and underscores with no hyphen,
 * so its `dsb_*` codes never match. Both hosts match codes case-insensitively, so
 * `ds-045409` routes the same as `DS-045409`.
 */
export function isComextDataset(datasetCode: string): boolean {
  return /^ds-/i.test(datasetCode);
}

/** Base URL of the host that serves `datasetCode`. */
export function dataHostFor(datasetCode: string): string {
  const { baseUrl, comextBaseUrl } = getServerConfig();
  return isComextDataset(datasetCode) ? comextBaseUrl : baseUrl;
}
