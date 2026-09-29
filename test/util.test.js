const test = require('node:test');
const assert = require('node:assert');
const { JCUtil } = require('../addon/content/lib/util.js');
const { parseHTML } = require('linkedom');

test('parseName', () => {
	assert.deepStrictEqual(JCUtil.parseName('Rossi, Mario'), { firstName: 'Mario', lastName: 'Rossi', creatorType: 'author' });
	assert.deepStrictEqual(JCUtil.parseName('Mario ROSSI'), { firstName: 'Mario', lastName: 'Rossi', creatorType: 'author' });
	assert.deepStrictEqual(JCUtil.parseName('Giulia Della Rocca'), { firstName: 'Giulia', lastName: 'Della Rocca', creatorType: 'author' });
	assert.deepStrictEqual(JCUtil.parseName('Prof. Anna Maria Bianchi'), { firstName: 'Anna Maria', lastName: 'Bianchi', creatorType: 'author' });
});

test('parseAuthors', () => {
	let a = JCUtil.parseAuthors('Mario Rossi, Anna Bianchi e Luca Verdi');
	assert.deepStrictEqual(a.map(c => c.lastName), ['Rossi', 'Bianchi', 'Verdi']);
});

test('parseDate', () => {
	assert.strictEqual(JCUtil.parseDate('12 marzo 2025'), '2025-03-12');
	assert.strictEqual(JCUtil.parseDate('2024-1-5'), '2024-01-05');
	assert.strictEqual(JCUtil.parseDate('05/11/2023'), '2023-11-05');
	assert.strictEqual(JCUtil.parseDate('Fascicolo n. 3/2022'), '2022');
	assert.strictEqual(JCUtil.parseDate('Settembre 2021'), '2021-09');
});

test('normalizeUrl', () => {
	assert.strictEqual(JCUtil.normalizeUrl('http://www.Example.it/a/b/?utm_source=x#top'), 'https://example.it/a/b');
});

test('isPdfBytes', () => {
	assert.ok(JCUtil.isPdfBytes(new TextEncoder().encode('%PDF-1.7 ...')));
	assert.ok(!JCUtil.isPdfBytes(new TextEncoder().encode('<html>')));
});

test('decode latin1', () => {
	let bytes = Uint8Array.from([0x63, 0x69, 0x74, 0xe0]); // "città" in ISO-8859-1
	assert.strictEqual(JCUtil.decode(bytes, 'text/html; charset=ISO-8859-1'), 'cità');
});

test('parseEmbeddedMeta', () => {
	let { document } = parseHTML(`<html><head>
		<meta name="citation_title" content="La riforma &amp; il resto">
		<meta name="citation_author" content="Rossi, Mario"><meta name="citation_author" content="Bianchi, Anna">
		<meta name="citation_publication_date" content="2024/05/02"><meta name="citation_volume" content="12">
		<meta name="citation_issue" content="2"><meta name="citation_firstpage" content="10"><meta name="citation_lastpage" content="30">
		<meta name="citation_doi" content="https://doi.org/10.1234/abc"><meta name="citation_pdf_url" content="/files/a.pdf">
		</head><body></body></html>`);
	let { meta, pdfUrl } = JCUtil.parseEmbeddedMeta(document, 'https://x.it/art/1');
	assert.strictEqual(meta.title, 'La riforma & il resto');
	assert.strictEqual(meta.creators.length, 2);
	assert.strictEqual(meta.date, '2024-05-02');
	assert.strictEqual(meta.pages, '10-30');
	assert.strictEqual(meta.DOI, '10.1234/abc');
	assert.strictEqual(pdfUrl, 'https://x.it/files/a.pdf');
});
