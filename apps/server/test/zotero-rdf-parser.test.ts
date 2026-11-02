/**
 * The Zotero RDF/XML export parser (scripts/zotero-rdf-parser.mts) — the
 * front half of the bulk importer (the Task-6 planner consumes the exported
 * ZoteroRdfItem shape verbatim).
 *
 * The fixtures are REAL SHAPES from the owner's export (Mi biblioteca.rdf,
 * Zotero RDF/XML export), minimal excerpts copied inline: a bib:Book (ISBN
 * text identifier, foaf publisher, creators Seq, link:link attachment,
 * z:citationKey), a journalArticle (DOI text identifier + dcterms:URI
 * identifier + z:PMID + isPartOf journal resolution), the statute with
 * dcterms:URI/rdf:value and a surname-only creator (Review Focus 1+2), and a
 * `case` item (itemType survives for the planner's class mapping).
 *
 * Rules pinned here:
 *  - z:Attachment and z:Collection resources are counted, never in items;
 *  - creators render "Family, Given"; surname-only yields the bare surname
 *    with NO trailing comma+space;
 *  - dc:identifier parses all three shapes (prefixed text, plain URL,
 *    dcterms:URI/rdf:value);
 *  - unknown/irregular element content THROWS naming the item URI;
 *  - XML entities are decoded.
 */

import { describe, expect, it } from "vitest";

import { parseZoteroRdf, type ZoteroRdfItem } from "../../../scripts/zotero-rdf-parser.mts";

/** The owner's export preamble — namespaces verbatim. */
const RDF_HEADER = `<rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:z="http://www.zotero.org/namespaces/export#"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:vcard="http://nwalsh.com/rdf/vCard#"
 xmlns:foaf="http://xmlns.com/foaf/0.1/"
 xmlns:bib="http://purl.org/net/biblio#"
 xmlns:link="http://purl.org/rss/1.0/modules/link/"
 xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/"
 xmlns:dcterms="http://purl.org/dc/terms/">`;

const RDF_FOOTER = `</rdf:RDF>`;

/** The Elahi book — the opening item of the owner's export. */
const BOOK_FIXTURE = `
    <bib:Book rdf:about="urn:isbn:978-0-323-85755-0">
        <z:itemType>book</z:itemType>
        <dc:publisher>
            <foaf:Organization>
                <vcard:adr>
                    <vcard:Address>
                        <vcard:locality>London San Diego, CA Cambridge, MA Oxford</vcard:locality>
                    </vcard:Address>
                </vcard:adr>
                <foaf:name>Academic Press</foaf:name>
            </foaf:Organization>
        </dc:publisher>
        <bib:authors>
            <rdf:Seq>
                <rdf:li>
                    <foaf:Person>
                        <foaf:surname>Elahi</foaf:surname>
                        <foaf:givenName>Bijan</foaf:givenName>
                    </foaf:Person>
                </rdf:li>
            </rdf:Seq>
        </bib:authors>
        <link:link rdf:resource="#item_6293"/>
        <dc:title>Safety risk management for medical devices</dc:title>
        <dc:date>2022</dc:date>
        <z:language>en</z:language>
        <z:libraryCatalog>K10plus ISBN</z:libraryCatalog>
        <dc:identifier>ISBN 978-0-323-85755-0</dc:identifier>
        <prism:edition>Second edition</prism:edition>
        <z:numPages>515</z:numPages>
        <z:citationKey>elahiSafetyRiskManagement2022</z:citationKey>
    </bib:Book>
    <z:Attachment rdf:about="#item_6293">
        <z:itemType>attachment</z:itemType>
        <z:path rdf:resource="attachments:elahiSafetyRiskManagement2022.pdf"/>
        <dc:title>elahiSafetyRiskManagement2022.pdf</dc:title>
        <z:linkMode>2</z:linkMode>
        <link:type>application/pdf</link:type>
    </z:Attachment>`;

/** A journalArticle + its bib:Journal resource (the isPartOf target). */
const ARTICLE_FIXTURE = `
    <bib:Article rdf:about="https://pubmed.ncbi.nlm.nih.gov/26827067/">
        <z:itemType>journalArticle</z:itemType>
        <dcterms:isPartOf rdf:resource="urn:issn:1698-6946"/>
        <dc:publisher>
            <foaf:Organization>
               <foaf:name>Med Oral Patol Oral Cir Bucal</foaf:name>
            </foaf:Organization>
        </dc:publisher>
        <bib:authors>
            <rdf:Seq>
                <rdf:li>
                    <foaf:Person>
                        <foaf:surname>Lozano-Carrascal</foaf:surname>
                        <foaf:givenName>Naroa</foaf:givenName>
                    </foaf:Person>
                </rdf:li>
                <rdf:li>
                    <foaf:Person>
                        <foaf:surname>Salomó-Coll</foaf:surname>
                        <foaf:givenName>Oscar</foaf:givenName>
                    </foaf:Person>
                </rdf:li>
            </rdf:Seq>
        </bib:authors>
        <link:link rdf:resource="#item_5950"/>
        <dc:title>Mechanical complications of zirconia implants</dc:title>
        <dcterms:abstract>The variable &quot;Fracture Torque,&quot; although p &lt; 0.001, was not significant (p &gt; 0.05).</dcterms:abstract>
        <dc:date>2021-12-02</dc:date>
        <dc:identifier>
            <dcterms:URI>
               <rdf:value>https://pubmed.ncbi.nlm.nih.gov/34899914/</rdf:value>
            </dcterms:URI>
        </dc:identifier>
        <dc:identifier>DOI 10.1155/2021/5133556</dc:identifier>
        <bib:pages>1-7</bib:pages>
        <z:PMID>34899914</z:PMID>
        <z:citationKey>silvaComparisonMechanicalResistance2021</z:citationKey>
    </bib:Article>
    <bib:Journal rdf:about="urn:issn:1698-6946">
        <prism:volume>21</prism:volume>
        <dc:title>Medicina oral, patologia oral y cirugia bucal</dc:title>
        <dc:identifier>DOI 10.4317/MEDORAL.21024</dc:identifier>
        <prism:number>2</prism:number>
        <dc:identifier>ISSN 1698-6946</dc:identifier>
    </bib:Journal>
    <z:Attachment rdf:about="#item_5950">
        <z:itemType>attachment</z:itemType>
        <z:path rdf:resource="attachments:silvaComparisonMechanicalResistance2021.pdf"/>
        <dc:title>silvaComparisonMechanicalResistance2021.pdf</dc:title>
        <z:linkMode>2</z:linkMode>
        <link:type>application/pdf</link:type>
    </z:Attachment>`;

/** The 93/42/EEC statute — dcterms:URI/rdf:value + surname-only creator. */
const STATUTE_FIXTURE = `
    <bib:Legislation rdf:about="http://data.europa.eu/eli/dir/1993/42/oj/eng">
        <z:itemType>statute</z:itemType>
        <bib:authors>
            <rdf:Seq>
                <rdf:li>
                    <foaf:Person>
                       <foaf:surname>European Comission</foaf:surname>
                    </foaf:Person>
                </rdf:li>
            </rdf:Seq>
        </bib:authors>
        <link:link rdf:resource="#item_5954"/>
        <dc:identifier>
            <dcterms:URI>
               <rdf:value>http://data.europa.eu/eli/dir/1993/42/oj/eng</rdf:value>
            </dcterms:URI>
        </dc:identifier>
        <dc:title>Council Directive 93/42/EEC of 14 June 1993 concerning medical devices</dc:title>
        <dc:date>1993-06-14</dc:date>
    </bib:Legislation>
    <z:Attachment rdf:about="#item_5954">
        <z:itemType>attachment</z:itemType>
        <z:path rdf:resource="attachments:europeanComissionCouncilDirective9342EEC.pdf"/>
        <dc:title>europeanComissionCouncilDirective9342EEC.pdf</dc:title>
        <z:linkMode>2</z:linkMode>
        <link:type>application/pdf</link:type>
    </z:Attachment>`;

/** The C-308/11 case — itemType "case" must survive for the planner. */
const CASE_FIXTURE = `
    <bib:Document rdf:about="https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:62011CJ0308">
        <z:itemType>case</z:itemType>
        <dcterms:isPartOf>
           <bib:CourtReporter></bib:CourtReporter>
        </dcterms:isPartOf>
        <link:link rdf:resource="#item_5917"/>
        <dc:identifier>
            <dcterms:URI>
                <rdf:value>https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:62011CJ0308</rdf:value>
            </dcterms:URI>
        </dc:identifier>
        <dc:title>C-308/11</dc:title>
        <z:authority>Oberlandesgericht Frankfurt am Main</z:authority>
        <z:citationKey>C-308-11</z:citationKey>
    </bib:Document>
    <z:Attachment rdf:about="#item_5917">
        <z:itemType>attachment</z:itemType>
        <z:path rdf:resource="attachments:C-308-11.pdf"/>
        <dc:title>C-308-11.pdf</dc:title>
        <z:linkMode>2</z:linkMode>
        <link:type>application/pdf</link:type>
    </z:Attachment>`;

/** A z:Collection resource — counted only. */
const COLLECTION_FIXTURE = `
    <z:Collection rdf:about="#collection_64">
        <dc:title>GMI</dc:title>
        <dcterms:hasPart rdf:resource="#item_1058"/>
    </z:Collection>`;

/** A journalArticle with the journal INLINE (the nested isPartOf shape). */
const INLINE_JOURNAL_FIXTURE = `
    <bib:Article rdf:about="https://pubmed.ncbi.nlm.nih.gov/31703918/">
        <z:itemType>journalArticle</z:itemType>
        <dcterms:isPartOf>
            <bib:Journal>
                <prism:volume>123</prism:volume>
                <dc:title>The Journal of prosthetic dentistry</dc:title>
                <dc:identifier>DOI 10.1016/J.PROSDENT.2019.09.014</dc:identifier>
                <prism:number>6</prism:number>
                <dc:identifier>ISSN 1097-6841</dc:identifier>
            </bib:Journal>
        </dcterms:isPartOf>
        <dc:publisher>
            <foaf:Organization>
               <foaf:name>J Prosthet Dent</foaf:name>
            </foaf:Organization>
        </dc:publisher>
        <bib:authors>
            <rdf:Seq>
                <rdf:li>
                    <foaf:Person>
                        <foaf:surname>Yeung</foaf:surname>
                        <foaf:givenName>Man Ming</foaf:givenName>
                    </foaf:Person>
                </rdf:li>
            </rdf:Seq>
        </bib:authors>
        <link:link rdf:resource="#item_6188"/>
        <dc:title>Accuracy of 3D printed models</dc:title>
        <dc:date>2020-06</dc:date>
        <bib:pages>821-828</bib:pages>
        <z:PMID>31703918</z:PMID>
        <z:citationKey>yeungAccuracyPrecision3Dprinted2020</z:citationKey>
    </bib:Article>`;

/** Place-only publisher — a regular Zotero export shape (106 of 376 in the
 * owner's file): the foaf:Organization carries just vcard:adr/locality. */
const PLACE_PUBLISHER_FIXTURE = `
    <bib:Book rdf:about="urn:isbn:978-0-14-198851-1">
        <z:itemType>book</z:itemType>
        <dc:publisher>
            <foaf:Organization>
                <vcard:adr>
                    <vcard:Address>
                       <vcard:locality>London</vcard:locality>
                    </vcard:Address>
                </vcard:adr>
            </foaf:Organization>
        </dc:publisher>
        <bib:authors>
            <rdf:Seq>
                <rdf:li>
                    <foaf:Person>
                        <foaf:surname>Kahneman</foaf:surname>
                        <foaf:givenName>Daniel</foaf:givenName>
                    </foaf:Person>
                </rdf:li>
            </rdf:Seq>
        </bib:authors>
        <dc:title>Thinking, fast and slow</dc:title>
        <dc:date>2012</dc:date>
    </bib:Book>`;

/** An editors Seq (the Handbook of pharmaceutical excipients shape). */
const EDITORS_FIXTURE = `
    <bib:Book rdf:about="urn:isbn:978-1-58212-058-4">
        <z:itemType>book</z:itemType>
        <bib:editors>
            <rdf:Seq>
                <rdf:li>
                    <foaf:Person>
                        <foaf:surname>Rowe</foaf:surname>
                        <foaf:givenName>Raymond C.</foaf:givenName>
                    </foaf:Person>
                </rdf:li>
            </rdf:Seq>
        </bib:editors>
        <dc:title>Handbook of pharmaceutical excipients</dc:title>
        <dc:date>2006</dc:date>
        <z:shortTitle>Handbook of pharmaceutical excipients</z:shortTitle>
        <dc:subject>
           <dcterms:LCC><rdf:value>RS201.E87 H36 2006</rdf:value></dcterms:LCC>
        </dc:subject>
        <dc:identifier>ISBN 978-1-58212-058-4 978-0-85369-618-6</dc:identifier>
        <prism:edition>5th ed</prism:edition>
    </bib:Book>`;

function parse(body: string) {
  return parseZoteroRdf(`${RDF_HEADER}${body}\n${RDF_FOOTER}`);
}

function onlyItem(result: { items: ZoteroRdfItem[] }, uri: string): ZoteroRdfItem {
  expect(result.items).toHaveLength(1);
  const item = result.items[0]!;
  expect(item.uri).toBe(uri);
  return item;
}

describe("parseZoteroRdf", () => {
  it("parses the bib:Book shape — vocab fields, creator rendering, citation key", () => {
    const result = parse(BOOK_FIXTURE);
    const book = onlyItem(result, "urn:isbn:978-0-323-85755-0");

    expect(book.itemType).toBe("book");
    expect(book.citationKey).toBe("elahiSafetyRiskManagement2022");
    expect(book.title).toBe("Safety risk management for medical devices");
    expect(book.fields).toEqual({
      publicationDate: "2022",
      publisher: "Academic Press",
      language: "en",
      libraryCatalog: "K10plus ISBN",
      isbn: "978-0-323-85755-0",
      edition: "Second edition",
      numPages: "515",
    });
    expect(book.creators).toEqual([{ role: "authors", names: ["Elahi, Bijan"] }]);
    expect(book.attachmentRefs).toEqual(["#item_6293"]);

    // The attachment resource is counted, never an item.
    expect(result.attachments).toBe(1);
    expect(result.collections).toBe(0);
  });

  it("parses the journalArticle — DOI + dcterms:URI + PMID, journal resolution, entities decoded", () => {
    const result = parse(ARTICLE_FIXTURE);
    const article = onlyItem(result, "https://pubmed.ncbi.nlm.nih.gov/26827067/");

    expect(article.itemType).toBe("journalArticle");
    expect(article.fields.doi).toBe("10.1155/2021/5133556");
    expect(article.fields.pmid).toBe("34899914");
    expect(article.fields.url).toBe("https://pubmed.ncbi.nlm.nih.gov/34899914/");
    expect(article.fields.pages).toBe("1-7");
    // Journal-resource resolution via dcterms:isPartOf (item's own values win).
    expect(article.fields.volume).toBe("21");
    expect(article.fields.issue).toBe("2");
    expect(article.fields.issn).toBe("1698-6946");
    expect(article.fields.publicationTitle).toBe(
      "Medicina oral, patologia oral y cirugia bucal",
    );
    // The JOURNAL's own DOI must not pollute the article's doi.
    expect(article.fields.doi).toBe("10.1155/2021/5133556");
    // Entities decoded.
    expect(article.fields.abstract).toBe(
      'The variable "Fracture Torque," although p < 0.001, was not significant (p > 0.05).',
    );
    expect(article.creators).toEqual([
      { role: "authors", names: ["Lozano-Carrascal, Naroa", "Salomó-Coll, Oscar"] },
    ]);
    expect(result.attachments).toBe(1);
  });

  it("parses the statute — dcterms:URI/rdf:value and a surname-only creator (Review Focus 1+2)", () => {
    const result = parse(STATUTE_FIXTURE);
    const statute = onlyItem(result, "http://data.europa.eu/eli/dir/1993/42/oj/eng");

    expect(statute.itemType).toBe("statute");
    expect(statute.fields.url).toBe("http://data.europa.eu/eli/dir/1993/42/oj/eng");
    expect(statute.fields.publicationDate).toBe("1993-06-14");
    // Surname-only: the bare surname, NO trailing comma+space.
    expect(statute.creators).toEqual([{ role: "authors", names: ["European Comission"] }]);
  });

  it("keeps itemType \"case\" verbatim for the planner's class mapping", () => {
    const result = parse(CASE_FIXTURE);
    const cas = onlyItem(
      result,
      "https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:62011CJ0308",
    );

    expect(cas.itemType).toBe("case");
    expect(cas.citationKey).toBe("C-308-11");
    expect(cas.fields.court).toBe("Oberlandesgericht Frankfurt am Main");
    // The nested (resource-less) dcterms:isPartOf is tolerated, not fatal.
    expect(cas.fields).not.toHaveProperty("publicationTitle");
  });

  it("counts collection resources but never lists them as items", () => {
    const result = parse(BOOK_FIXTURE + COLLECTION_FIXTURE);

    expect(result.collections).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.itemType).toBe("book");
    expect(result.attachments).toBe(1);
  });

  it("maps editors Seq to the editors role and dcterms:LCC to callNumber", () => {
    const result = parse(EDITORS_FIXTURE);
    const handbook = onlyItem(result, "urn:isbn:978-1-58212-058-4");

    expect(handbook.creators).toEqual([{ role: "editors", names: ["Rowe, Raymond C."] }]);
    expect(handbook.fields.callNumber).toBe("RS201.E87 H36 2006");
    expect(handbook.fields.shortTitle).toBe("Handbook of pharmaceutical excipients");
    // A doubled ISBN line yields the primary (first) identifier.
    expect(handbook.fields.isbn).toBe("978-1-58212-058-4");
  });

  it("resolves an INLINE nested bib:Journal (isPartOf without rdf:resource)", () => {
    const result = parse(INLINE_JOURNAL_FIXTURE);
    const article = onlyItem(result, "https://pubmed.ncbi.nlm.nih.gov/31703918/");

    expect(article.fields.volume).toBe("123");
    expect(article.fields.issue).toBe("6");
    expect(article.fields.issn).toBe("1097-6841");
    expect(article.fields.publicationTitle).toBe("The Journal of prosthetic dentistry");
    // The journal's own DOI is not the article's.
    expect(article.fields.doi).toBeUndefined();
    expect(article.fields.pmid).toBe("31703918");
    expect(article.fields.pages).toBe("821-828");
  });

  it("maps a place-only publisher (vcard:locality) to the publisher field", () => {
    const result = parse(PLACE_PUBLISHER_FIXTURE);
    const book = onlyItem(result, "urn:isbn:978-0-14-198851-1");

    expect(book.fields.publisher).toBe("London");
    expect(book.fields.publicationDate).toBe("2012");
    expect(book.creators).toEqual([{ role: "authors", names: ["Kahneman, Daniel"] }]);
  });

  it("throws on irregular dc:identifier content, naming the item URI", () => {
    const body = `
    <bib:Document rdf:about="#item_irregular">
        <z:itemType>document</z:itemType>
        <dc:title>Irregular item</dc:title>
        <dc:identifier>CallNumber RS201.E87 H36 2006</dc:identifier>
    </bib:Document>`;

    expect(() => parse(body)).toThrow(/#item_irregular/);
  });

  it("throws when an item carries no dc:title, naming the item URI", () => {
    const body = `
    <bib:Document rdf:about="#item_untitled">
        <z:itemType>document</z:itemType>
        <dc:date>2020</dc:date>
    </bib:Document>`;

    expect(() => parse(body)).toThrow(/#item_untitled/);
  });
});
