/* global JCAdapters, JCUtil */

/**
 * Berkeley Journal of International Law.
 *
 * The journal left Digital Commons (scholarship.law.berkeley.edu, now 404): its articles are in
 * LawCat, the Berkeley Law repository (TIND). LawCat has no per-journal OAI set, so the set of
 * all Berkeley Law journals is harvested in MARCXML and only the records whose host item
 * (MARC 773$t) is the journal are kept. MARC gives title, authors, date, volume/issue/first
 * page, DOI and the PDF.
 *
 * Record pages and PDFs on lawcat.berkeley.edu answer plain HTTP with an AWS WAF challenge
 * (HTTP 202, empty body), so no landing page is read; in Zotero the PDF needs the hidden browser.
 *
 * Incremental: after a complete harvest the responseDate is kept in state.oaiFrom.
 */
JCAdapters.register({
	id: 'berkeley-international-law',
	label: 'Berkeley Journal of International Law (LawCat)',
	description: 'OAI-PMH of LawCat (Berkeley Law, TIND) in MARCXML, filtered on the journal (MARC 773$t).',
	params: {
		endpoint: 'OAI-PMH endpoint (default https://lawcat.berkeley.edu/oai2d)',
		set: 'OAI set (default berkeleylawjournals)',
		journal: 'regex matched against MARC 773$t (default ^Berkeley Journal of International Law)',
		skipPattern: 'regex: skip records whose document type (MARC 655$a) or title matches',
	},

	async *discover(ctx) {
		let p = ctx.params;
		let endpoint = p.endpoint || 'https://lawcat.berkeley.edu/oai2d';
		let journalRe = new RegExp(p.journal || '^Berkeley Journal of International Law', 'i');
		let skipRe = new RegExp(p.skipPattern
			|| '^(full issue|front matter|back matter|masthead|cover|table of contents|title index)|(front matter|full issue)$', 'i');
		let from = ctx.state.oaiFrom || null;
		let n = 0;
		for await (let rec of JCAdapters.oaiRecords(ctx, { endpoint, prefix: 'marcxml', set: p.set || 'berkeleylawjournals', from })) {
			if (rec.header.deleted || !rec.metadata) continue;
			// MARC datafields: {tag: [{code: value}]}
			let f = {};
			for (let df of JCAdapters.xml(rec.metadata, 'datafield')) {
				let sub = {};
				for (let sf of JCAdapters.xml(df, 'subfield')) {
					let c = sf.getAttribute('code');
					if (!(c in sub)) sub[c] = JCUtil.text(sf);
				}
				let tag = df.getAttribute('tag');
				(f[tag] = f[tag] || []).push(sub);
			}
			let first = (tag, code) => (f[tag] && f[tag][0] && f[tag][0][code]) || '';
			if (!journalRe.test(first('773', 't'))) continue;
			let title = JCUtil.cleanTitle([first('245', 'a'), first('245', 'b')].filter(Boolean).join(': '));
			if (!title || skipRe.test(first('655', 'a')) || skipRe.test(title)) continue;
			let date = JCUtil.parseDate(first('264', 'c') || first('269', 'a') || first('260', 'c'));
			if (ctx.tooOld(date)) continue;
			let id = /(\d+)$/.exec(rec.header.identifier);
			let url = id ? `https://lawcat.berkeley.edu/record/${id[1]}` : null;
			let pdfUrls = (f['856'] || []).map(s => s.u).filter(u => u && /\.pdf$/i.test(u));
			let meta = {
				title,
				creators: [...(f['100'] || []), ...(f['700'] || [])].map(s => JCUtil.parseName(s.a)).filter(Boolean),
				date,
				volume: first('773', 'j'),
				issue: first('773', 'k'),
				pages: first('773', 'q'),
				publicationTitle: 'Berkeley Journal of International Law',
				journalAbbreviation: first('773', 'p'),
				abstractNote: first('520', 'a'),
				language: first('041', 'a'),
			};
			let doi = (f['024'] || []).find(s => /doi/i.test(s['2'] || '') || /^10\.\d{4,9}\//.test(s.a || ''));
			if (doi && doi.a) meta.DOI = doi.a.replace(/^doi:\s*/i, '');
			n++;
			yield { key: url || pdfUrls[0], url, pdfUrls, meta, landing: false };
		}
		if (!ctx.cancelled && ctx._oaiResponseDate) {
			let d = new Date(ctx._oaiResponseDate);
			if (!isNaN(d)) {
				d.setUTCDate(d.getUTCDate() - 1);
				ctx.state.oaiFrom = d.toISOString().slice(0, 10);
			}
		}
		ctx.log(`LawCat: ${n} records of the journal${from ? ' changed since ' + from : ''}`);
	},
});
