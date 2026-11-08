/**
 * @fileoverview Tests for the filter normalization both data tools share, and the check
 * that names the filter keys a dataset has no dimension for.
 * @module tests/services/eurostat-filters.test
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeFilters,
  unknownDimensionsMessage,
  unknownFilterKeys,
} from '@/services/eurostat-filters.js';

describe('normalizeFilters', () => {
  it('drops blank values and the dimensions they leave empty', () => {
    expect(normalizeFilters({ geo: ['', 'DE', '  '], unit: [], na_item: ['\t'] })).toEqual({
      geo: ['DE'],
    });
  });

  it('keeps a non-blank value as given', () => {
    expect(normalizeFilters({ geo: [' DE'] })).toEqual({ geo: [' DE'] });
  });

  it('splits a value holding "+" into one value per code', () => {
    expect(normalizeFilters({ geo: ['DE+FR'] })).toEqual({ geo: ['DE', 'FR'] });
    expect(normalizeFilters({ geo: ['AT', 'DE+FR+IT'] })).toEqual({
      geo: ['AT', 'DE', 'FR', 'IT'],
    });
  });

  it('drops the blank pieces of a "+" value', () => {
    expect(normalizeFilters({ geo: ['DE+'] })).toEqual({ geo: ['DE'] });
    expect(normalizeFilters({ geo: ['+DE++ +FR'] })).toEqual({ geo: ['DE', 'FR'] });
    expect(normalizeFilters({ geo: ['+'], unit: ['CP_MEUR'] })).toEqual({ unit: ['CP_MEUR'] });
  });
});

describe('unknownFilterKeys', () => {
  const order = ['freq', 'statinfo', 'unit', 'rskpovth', 'sex', 'age', 'geo'];

  it('names the keys no dimension matches, in the order given', () => {
    expect(unknownFilterKeys(order, ['geo', 'indic_il', 'incgrp'])).toEqual(['indic_il', 'incgrp']);
  });

  it('matches a key to its dimension in any case', () => {
    expect(unknownFilterKeys(order, ['GEO', 'Unit', 'INDIC_IL'])).toEqual(['INDIC_IL']);
  });

  it('names nothing when every key is a dimension, or no key is given', () => {
    expect(unknownFilterKeys(order, ['geo', 'sex'])).toEqual([]);
    expect(unknownFilterKeys(order, [])).toEqual([]);
  });
});

describe('unknownDimensionsMessage', () => {
  it('names one key and lists the dimensions in key order', () => {
    expect(unknownDimensionsMessage(['country'], ['unit', 'geo'])).toBe(
      'Filter names "country", which is not a dimension of this dataset. Filterable dimensions, in key order: unit, geo.',
    );
  });

  it('names every key', () => {
    expect(
      unknownDimensionsMessage(
        ['indic_il', 'incgrp'],
        ['freq', 'statinfo', 'unit', 'rskpovth', 'sex', 'age', 'geo'],
      ),
    ).toBe(
      'Filter names "indic_il", "incgrp", which are not dimensions of this dataset. Filterable dimensions, in key order: freq, statinfo, unit, rskpovth, sex, age, geo.',
    );
  });
});
