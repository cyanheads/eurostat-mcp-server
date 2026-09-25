/**
 * @fileoverview Host routing: which dataset codes go to the Comext host.
 * @module tests/services/eurostat-hosts.test
 */

import { describe, expect, it } from 'vitest';
import { dataHostFor, isComextDataset } from '@/services/eurostat-hosts.js';
import { COMEXT_HOST, MAIN_HOST } from '../helpers/comext-fixtures.js';

describe('isComextDataset / dataHostFor', () => {
  it.each(['DS-045409', 'ds-045409', 'Ds-059358', 'DS-999999'])(
    'routes %s to the Comext host',
    (code) => {
      expect(isComextDataset(code)).toBe(true);
      expect(dataHostFor(code)).toBe(COMEXT_HOST);
    },
  );

  /** Main-host codes that begin with "ds" but carry no hyphen, as the live catalogue lists them. */
  it.each(['dsb_ictiu08', 'DSB_ICTIU08', 'dsb_p', 'nama_10_gdp', 'ds', 'ds_045409', 'xds-1'])(
    'keeps %s on the main host',
    (code) => {
      expect(isComextDataset(code)).toBe(false);
      expect(dataHostFor(code)).toBe(MAIN_HOST);
    },
  );
});
