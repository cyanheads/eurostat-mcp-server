/**
 * @fileoverview Deterministic SDMX structure fixtures for Eurostat metadata tests.
 * @module tests/fixtures/eurostat-sdmx-metadata
 */

export const SDMX_DATAFLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<m:Structure xmlns:m="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:s="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:c="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common">
  <m:Structures>
    <s:Dataflows>
      <s:Dataflow agencyID="ESTAT" id="EARN_SES_ANNUAL" version="1.0">
        <c:Annotations>
          <c:Annotation><c:AnnotationTitle>6160543</c:AnnotationTitle><c:AnnotationType>OBS_COUNT</c:AnnotationType></c:Annotation>
          <c:Annotation><c:AnnotationTitle>2002</c:AnnotationTitle><c:AnnotationType>OBS_PERIOD_OVERALL_OLDEST</c:AnnotationType></c:Annotation>
          <c:Annotation><c:AnnotationTitle>2022</c:AnnotationTitle><c:AnnotationType>OBS_PERIOD_OVERALL_LATEST</c:AnnotationType></c:Annotation>
          <c:Annotation><c:AnnotationTitle>2026-02-09T23:00:00+0100</c:AnnotationTitle><c:AnnotationType>UPDATE_DATA</c:AnnotationType></c:Annotation>
          <c:Annotation><c:AnnotationType>ESMS_HTML</c:AnnotationType><c:AnnotationURL>https://example.test/earn_ses_esms.htm</c:AnnotationURL></c:Annotation>
        </c:Annotations>
        <c:Name xml:lang="fr">Structure des salaires</c:Name>
        <c:Name xml:lang="en">Structure of earnings survey: annual earnings</c:Name>
      </s:Dataflow>
    </s:Dataflows>
    <s:Codelists>
      <s:Codelist agencyID="ESTAT" id="FREQ" version="1.0">
        <c:Name xml:lang="en">Frequency</c:Name>
        <s:Code id="A"><c:Name xml:lang="en">Annual</c:Name></s:Code>
      </s:Codelist>
      <s:Codelist agencyID="ESTAT" id="UNIT" version="1.0">
        <c:Name xml:lang="en">Unit of measure</c:Name>
        ${Array.from({ length: 11 }, (_, index) => {
          const code = `U${String(index + 1).padStart(2, '0')}`;
          const label = index === 0 ? 'Euro &amp; national currency' : `Unit ${index + 1}`;
          return `<s:Code id="${code}"><c:Name xml:lang="en">${label}</c:Name></s:Code>`;
        }).join('')}
      </s:Codelist>
      <s:Codelist agencyID="ESTAT" id="GEO" version="1.0">
        <c:Name xml:lang="en">Geopolitical entity</c:Name>
        <s:Code id="EU27_2020"><c:Annotations><c:Annotation><c:AnnotationTitle>AGG</c:AnnotationTitle><c:AnnotationType>LEVEL</c:AnnotationType></c:Annotation></c:Annotations><c:Name xml:lang="en">European Union - 27 countries</c:Name></s:Code>
        <s:Code id="EA20"><c:Annotations><c:Annotation><c:AnnotationTitle>AGG</c:AnnotationTitle><c:AnnotationType>LEVEL</c:AnnotationType></c:Annotation></c:Annotations><c:Name xml:lang="en">Euro area - 20 countries</c:Name></s:Code>
        <s:Code id="DE"><c:Annotations><c:Annotation><c:AnnotationTitle>0</c:AnnotationTitle><c:AnnotationType>LEVEL</c:AnnotationType></c:Annotation></c:Annotations><c:Name xml:lang="en">Germany</c:Name></s:Code>
        <s:Code id="FR"><c:Annotations><c:Annotation><c:AnnotationTitle>0</c:AnnotationTitle><c:AnnotationType>LEVEL</c:AnnotationType></c:Annotation></c:Annotations><c:Name xml:lang="en">France</c:Name></s:Code>
        <s:Code id="DE1"><c:Annotations><c:Annotation><c:AnnotationTitle>1</c:AnnotationTitle><c:AnnotationType>LEVEL</c:AnnotationType></c:Annotation></c:Annotations><c:Name xml:lang="en">Baden-Württemberg</c:Name></s:Code>
        <s:Code id="DE11"><c:Annotations><c:Annotation><c:AnnotationTitle>2</c:AnnotationTitle><c:AnnotationType>LEVEL</c:AnnotationType></c:Annotation></c:Annotations><c:Name xml:lang="en">Stuttgart</c:Name></s:Code>
        <s:Code id="DE111"><c:Annotations><c:Annotation><c:AnnotationTitle>3</c:AnnotationTitle><c:AnnotationType>LEVEL</c:AnnotationType></c:Annotation></c:Annotations><c:Name xml:lang="en">Stuttgart, Stadtkreis</c:Name></s:Code>
      </s:Codelist>
    </s:Codelists>
    <s:Concepts>
      <s:ConceptScheme agencyID="ESTAT" id="EARN_SES_ANNUAL" version="1.0">
        <s:Concept id="freq"><c:Name xml:lang="en">Frequency</c:Name></s:Concept>
        <s:Concept id="unit"><c:Name xml:lang="en">Unit of measure</c:Name></s:Concept>
        <s:Concept id="geo"><c:Name xml:lang="en">Geopolitical entity (reporting)</c:Name></s:Concept>
        <s:Concept id="TIME_PERIOD"><c:Name xml:lang="en">Time</c:Name></s:Concept>
      </s:ConceptScheme>
    </s:Concepts>
    <s:DataStructures>
      <s:DataStructure agencyID="ESTAT" id="EARN_SES_ANNUAL" version="1.0">
        <s:DataStructureComponents>
          <s:DimensionList>
            <s:Dimension id="freq" position="1"><s:ConceptIdentity><Ref id="freq"/></s:ConceptIdentity><s:LocalRepresentation><s:Enumeration><Ref id="FREQ"/></s:Enumeration></s:LocalRepresentation></s:Dimension>
            <s:Dimension id="unit" position="2"><s:ConceptIdentity><Ref id="unit"/></s:ConceptIdentity><s:LocalRepresentation><s:Enumeration><Ref id="UNIT"/></s:Enumeration></s:LocalRepresentation></s:Dimension>
            <s:Dimension id="geo" position="3"><s:ConceptIdentity><Ref id="geo"/></s:ConceptIdentity><s:LocalRepresentation><s:Enumeration><Ref id="GEO"/></s:Enumeration></s:LocalRepresentation></s:Dimension>
            <s:TimeDimension id="TIME_PERIOD" position="4"><s:ConceptIdentity><Ref id="TIME_PERIOD"/></s:ConceptIdentity></s:TimeDimension>
          </s:DimensionList>
        </s:DataStructureComponents>
      </s:DataStructure>
    </s:DataStructures>
  </m:Structures>
</m:Structure>`;

const unitValues = Array.from(
  { length: 11 },
  (_, index) => `<c:Value>U${String(index + 1).padStart(2, '0')}</c:Value>`,
).join('');

export const SDMX_CONSTRAINT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<m:Structure xmlns:m="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:s="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:c="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common">
  <m:Structures><s:Constraints><s:ContentConstraint agencyID="ESTAT" id="EARN_SES_ANNUAL" version="1.0"><s:CubeRegion include="true">
    <c:KeyValue id="freq"><c:Value>A</c:Value></c:KeyValue>
    <c:KeyValue id="unit">${unitValues}</c:KeyValue>
    <c:KeyValue id="geo"><c:Value>EU27_2020</c:Value><c:Value>EA20</c:Value><c:Value>DE</c:Value><c:Value>FR</c:Value><c:Value>DE1</c:Value><c:Value>DE11</c:Value><c:Value>DE111</c:Value></c:KeyValue>
    <c:KeyValue id="TIME_PERIOD"><c:Value>2002</c:Value><c:Value>2006</c:Value><c:Value>2010</c:Value><c:Value>2014</c:Value><c:Value>2018</c:Value><c:Value>2022</c:Value></c:KeyValue>
  </s:CubeRegion></s:ContentConstraint></s:Constraints></m:Structures>
</m:Structure>`;

export const SDMX_CONSTRAINT_WITHOUT_COUNTRIES_XML = SDMX_CONSTRAINT_XML.replace(
  '<c:KeyValue id="geo"><c:Value>EU27_2020</c:Value><c:Value>EA20</c:Value><c:Value>DE</c:Value><c:Value>FR</c:Value><c:Value>DE1</c:Value><c:Value>DE11</c:Value><c:Value>DE111</c:Value></c:KeyValue>',
  '<c:KeyValue id="geo"><c:Value>EU27_2020</c:Value><c:Value>EA20</c:Value><c:Value>DE1</c:Value><c:Value>DE11</c:Value><c:Value>DE111</c:Value></c:KeyValue>',
);
