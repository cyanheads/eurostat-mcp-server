/**
 * @fileoverview Unit tests for dataset-scoped SDMX metadata parsing.
 * @module tests/services/eurostat-sdmx-metadata.test
 */

import { describe, expect, it } from 'vitest';
import { parseSdmxDatasetMetadata } from '@/services/eurostat-data/sdmx-metadata.js';
import { SDMX_CONSTRAINT_XML, SDMX_DATAFLOW_XML } from '../fixtures/eurostat-sdmx-metadata.js';

describe('parseSdmxDatasetMetadata', () => {
  it('combines the dataflow descendants and content constraint without losing time values', () => {
    const parsed = parseSdmxDatasetMetadata(
      SDMX_DATAFLOW_XML,
      SDMX_CONSTRAINT_XML,
      'earn_ses_annual',
    );

    expect(parsed.meta).toMatchObject({
      code: 'earn_ses_annual',
      label: 'Structure of earnings survey: annual earnings',
      obsCount: 6_160_543,
      timeRange: { start: '2002', end: '2022' },
      lastUpdated: '2026-02-09T23:00:00+0100',
      metadataUrl: 'https://example.test/earn_ses_esms.htm',
    });
    expect(parsed.meta.dimensions.map(({ code }) => code)).toEqual(['freq', 'unit', 'geo', 'time']);

    const unit = parsed.meta.dimensions.find(({ code }) => code === 'unit');
    expect(unit?.valuesCount).toBe(11);
    expect(unit?.sampleValues).toHaveLength(10);
    expect(unit?.sampleValues?.[0]).toEqual({ code: 'U01', label: 'Euro & national currency' });

    const time = parsed.meta.dimensions.find(({ code }) => code === 'time');
    expect(time?.valuesCount).toBe(6);
    expect(time?.sampleValues?.map(({ code }) => code)).toEqual([
      '2002',
      '2006',
      '2010',
      '2014',
      '2018',
      '2022',
    ]);
    expect(parsed.valuesByDimension.geo?.map(({ code }) => code)).toEqual([
      'EU27_2020',
      'EA20',
      'DE',
      'FR',
      'DE1',
      'DE11',
      'DE111',
    ]);
    expect(parsed.geoLevelsByCode).toMatchObject({
      EU27_2020: 'aggregate',
      EA20: 'aggregate',
      DE: 'country',
      DE1: 'nuts1',
      DE11: 'nuts2',
      DE111: 'nuts3',
    });
  });

  it('keeps absent or unparseable annotations absent from the public contract', () => {
    const withoutAnnotations = SDMX_DATAFLOW_XML.replace(
      /<c:Annotations>[\s\S]*?<\/c:Annotations>/,
      '',
    );
    const absent = parseSdmxDatasetMetadata(
      withoutAnnotations,
      SDMX_CONSTRAINT_XML,
      'earn_ses_annual',
    ).meta;
    expect(absent.obsCount).toBeUndefined();
    expect(absent.timeRange).toEqual({});
    expect(absent.lastUpdated).toBeUndefined();
    expect(absent.metadataUrl).toBeUndefined();

    const unparseable = parseSdmxDatasetMetadata(
      SDMX_DATAFLOW_XML.replace('>6160543<', '>not-a-number<'),
      SDMX_CONSTRAINT_XML,
      'earn_ses_annual',
    ).meta;
    expect(unparseable.obsCount).toBeUndefined();
  });

  it('distinguishes a reported zero count and a single reported period bound', () => {
    const dataflow = SDMX_DATAFLOW_XML.replace('>6160543<', '>0<').replace(
      /<c:Annotation><c:AnnotationTitle>2022<\/c:AnnotationTitle><c:AnnotationType>OBS_PERIOD_OVERALL_LATEST<\/c:AnnotationType><\/c:Annotation>/,
      '',
    );
    const meta = parseSdmxDatasetMetadata(dataflow, SDMX_CONSTRAINT_XML, 'earn_ses_annual').meta;
    expect(meta.obsCount).toBe(0);
    expect(meta.timeRange).toEqual({ start: '2002' });
  });

  it('keeps an unenumerated dimension measurable as unknown rather than zero', () => {
    const withoutTimeEnumeration = parseSdmxDatasetMetadata(
      SDMX_DATAFLOW_XML,
      SDMX_CONSTRAINT_XML.replace(/<c:KeyValue id="TIME_PERIOD">[\s\S]*?<\/c:KeyValue>/, ''),
      'earn_ses_annual',
    );
    const time = withoutTimeEnumeration.meta.dimensions.find(({ code }) => code === 'time');

    expect(time?.valuesCount).toBeUndefined();
    expect(time?.sampleValues).toBeUndefined();
    expect(withoutTimeEnumeration.valuesByDimension.time).toEqual([]);
  });
});
