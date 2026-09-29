/* global JCAdapters, JCUtil */

/**
 * Janeway journals (Open Library of Humanities platform), through the OAI-PMH endpoint
 * <base>/api/oai/. Janeway's oai_dc carries non-standard elements (dc:volume, dc:issue,
 * dc:doi, dc:fullTextUrl) that the generic OAI adapter ignores; the article PDF is
 * <landing>/download/pdf/. Incremental by OAI datestamp (state.oaiFrom), like the oai adapter.
 * Landing pages and PDFs of some Janeway sites sit behind an Anubis bot check: set
 * params.browser = true so the plugin uses the hidden browser for them.
 */
JCAdapters.register({
	id: 'janeway',
	label: 'Janeway (OAI-PMH)',
	description: 'Janeway journals via <base>/api/oai/: title, authors, date, volume/issue, DOI, abstract; PDF at <article>/download/pdf/.',
	params: {
		base: 'journal site, e.g. https://journal.example.org',
		oai: 'OAI-PMH endpoint, if not <base>/api/oai/',
		skipPattern: 'regex: skip records whose title matches',
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.base) throw new Error('params.base missing');
		let base = p.base.replace(/\/+$/, '');
		let endpoint = p.oai || base + '/api/oai/';
		let from = ctx.state.oaiFrom || (ctx.since ? `${ctx.since}-01-01` : null);
		let skip = p.skipPattern ? new RegExp(p.skipPattern, 'i') : null;
		let n = 0;
		for await (let rec of JCAdapters.oaiRecords(ctx, { endpoint, from })) {
			if (rec.header.deleted || !rec.metadata) continue;
			let dc = JCAdapters.dublinCore(rec.metadata);
			let one = k => (dc[k] && dc[k][0] ? dc[k][0].text : '');
			let title = JCUtil.cleanTitle(one('title') || one('articletitle'));
			if (!title || (skip && skip.test(title))) continue;
			let date = JCUtil.parseDate(one('date'));
			if (ctx.tooOld(date)) continue;
			let url = one('fulltexturl') || null;
			let id = /:id:(\d+)$/.exec(rec.header.identifier);
			if (!url && id) url = `${base}/article/id/${id[1]}/`;
			if (!url) continue;
			if (!url.endsWith('/')) url += '/';
			let doi = one('doi') || ((/(10\.\d{4,9}\/\S+)/.exec((dc.identifier || []).map(i => i.text).join(' ')) || [])[1] || '');
			let meta = {
				title,
				creators: (dc.creator || []).map(c => JCUtil.parseName(c.text)).filter(Boolean),
				date,
				volume: one('volume'),
				issue: one('issue'),
				DOI: doi,
				abstractNote: one('description'),
				publicationTitle: one('journaltitle'),
				ISSN: (/\b(\d{4}-\d{3}[\dXx])\b/.exec(one('source')) || [])[1] || '',
				language: one('language'),
			};
			n++;
			yield { key: url, url, pdfUrl: url + 'download/pdf/', meta, landing: false };
		}
		if (!ctx.cancelled && ctx._oaiResponseDate) {
			let d = new Date(ctx._oaiResponseDate);
			if (!isNaN(d)) {
				d.setUTCDate(d.getUTCDate() - 1);
				ctx.state.oaiFrom = d.toISOString().slice(0, 10);
			}
		}
		ctx.log(`Janeway OAI: ${n} records${from ? ' changed since ' + from : ''}`);
	},
});
