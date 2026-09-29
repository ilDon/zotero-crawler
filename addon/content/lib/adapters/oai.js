/* global JCAdapters, JCUtil */

/**
 * Generic OAI-PMH harvesting (oai_dc), used directly for Digital Commons (bepress)
 * repositories and as the base of the OJS adapter.
 *
 * Incremental: after a complete harvest the responseDate is kept in state.oaiFrom and
 * the next run asks only for records added or changed since then.
 */
var JCOai = {
	/** Volume/issue/pages from strings like "Rivista; Vol. 10 No. 1 (2022): …; 963-995" */
	parseSource(source) {
		let out = {};
		// the journal name comes first ("Labour & Law Issues; Vol. 3 No. 1 (2017)") and must not be parsed
		let s = (source || '').includes(';') ? source.slice(source.indexOf(';') + 1) : (source || '');
		let m = /\b(?:vol\.?|v\.|volume|anno)\s*([\w.]+)/i.exec(s);
		if (m) out.volume = m[1].replace(/\.$/, '');
		m = /\b(?:no\.|n\.|num\.|fasc\.|(?:no|num|issue|fasc|fascicolo)(?=\s))\s*(\d[\w./-]*|[IVX]+\b|special\b|speciale\b)/i.exec(s);
		if (m) out.issue = m[1].replace(/\.$/, '');
		m = /;\s*(\d+(?:\s*[-–]\s*\d+)?)\s*$/.exec(s);
		// a bare year at the end is not a page range
		if (m && !/^(19|20)\d\d$/.test(m[1])) out.pages = m[1].replace(/\s+/g, '');
		m = /\((\d{4})\)/.exec(s);
		if (m) out.year = m[1];
		return out;
	},

	/**
	 * Turn an oai_dc record into a ref.
	 * @param {Object} opts - {landingPattern, pdfPattern, relationToPdf(url) → url|null}
	 */
	recordToRef(rec, opts = {}) {
		let dc = JCAdapters.dublinCore(rec.metadata);
		let lang = dc.language && dc.language[0] ? dc.language[0].text : '';
		let identifiers = (dc.identifier || []).map(v => v.text);
		let urls = identifiers.filter(u => /^https?:\/\//i.test(u));
		let pdfRe = opts.pdfPattern ? new RegExp(opts.pdfPattern, 'i') : /\.pdf($|\?)|viewcontent\.cgi|\/viewcontent\//i;
		let landingRe = opts.landingPattern ? new RegExp(opts.landingPattern, 'i') : null;
		let pdfUrls = urls.filter(u => pdfRe.test(u));
		let landing = urls.find(u => !pdfRe.test(u) && (!landingRe || landingRe.test(u))) || null;
		if (opts.relationToPdf) {
			for (let r of dc.relation || []) {
				let p = opts.relationToPdf(r.text);
				if (p) pdfUrls.push(p);
			}
		}
		// OJS 3.5 repeats each creator once per language
		// OJS 2 appends "; affiliation"; empty placeholders (" , ") are dropped
		let creatorNames = [...new Set((dc.creator || []).map(c => c.text.replace(/\s*;.*$/, '')))]
			.filter(n => /\p{L}/u.test(n));
		let meta = {
			title: JCUtil.cleanTitle(JCAdapters.pickLang(dc.title, lang)),
			creators: creatorNames.map(c => JCUtil.parseName(c)).filter(Boolean),
			date: JCUtil.parseDate((dc.date || [])[0] ? dc.date[0].text : ''),
			abstractNote: JCAdapters.pickLang(dc.description, lang),
			language: lang,
			tags: (dc.subject || []).map(s => s.text).filter(t => t.length < 80),
		};
		let doi = identifiers.map(i => /(10\.\d{4,9}\/\S+)/.exec(i)).find(Boolean);
		if (doi) meta.DOI = doi[1].replace(/[.,;]$/, '');
		let sources = (dc.source || []).map(s => s.text);
		let src = JCAdapters.pickLang(dc.source, lang) || '';
		Object.assign(meta, this.parseSource(src));
		delete meta.year;
		let issn = sources.map(s => /\b(\d{4}-\d{3}[\dXx])\b/.exec(s)).find(Boolean);
		if (issn) meta.ISSN = issn[1];
		return {
			key: landing || pdfUrls[0] || rec.header.identifier,
			url: landing,
			pdfUrls: [...new Set(pdfUrls)],
			meta,
			sets: rec.header.sets,
			oaiIdentifier: rec.header.identifier,
		};
	},

	/**
	 * Harvest an endpoint and yield refs, filtering sets.
	 * opts: {endpoint, set, excludeSets[], includeSets[], ...recordToRef opts}
	 */
	async *harvest(ctx, opts) {
		let state = ctx.state;
		// an article published in year Y cannot have been modified before Y
		let from = state.oaiFrom || (ctx.since ? `${ctx.since}-01-01` : null);
		let exclude = (opts.excludeSets || []).map(s => s.toLowerCase());
		let include = (opts.includeSets || []).map(s => s.toLowerCase());
		let skip = opts.skipPattern ? new RegExp(opts.skipPattern, 'i') : null;
		let n = 0;
		for await (let rec of JCAdapters.oaiRecords(ctx, { endpoint: opts.endpoint, set: opts.set, prefix: opts.prefix, from })) {
			if (rec.header.deleted || !rec.metadata) continue;
			let sets = rec.header.sets.map(s => s.toLowerCase());
			if (exclude.length && sets.some(s => exclude.some(e => s === e || s.endsWith(':' + e)))) continue;
			if (include.length && !sets.some(s => include.some(e => s === e || s.endsWith(':' + e)))) continue;
			let ref = this.recordToRef(rec, opts);
			if (!ref.meta.title || (skip && skip.test(ref.meta.title))) continue;
			if (ctx.tooOld(ref.meta.date)) continue;
			n++;
			yield ref;
		}
		if (!ctx.cancelled && ctx._oaiResponseDate) {
			// one day of overlap: some repositories only have day granularity
			let d = new Date(ctx._oaiResponseDate);
			if (!isNaN(d)) {
				d.setUTCDate(d.getUTCDate() - 1);
				state.oaiFrom = d.toISOString().slice(0, 10);
			}
		}
		ctx.log(`OAI-PMH: ${n} records${from ? ' changed since ' + from : ''}`);
	},
};

JCAdapters.register({
	id: 'oai',
	label: 'OAI-PMH (Digital Commons / bepress, repositories)',
	description: 'Harvests the OAI-PMH endpoint (oai_dc). Incremental by modification date.',
	params: {
		endpoint: 'OAI-PMH base URL, e.g. https://digitalcommons.example.edu/do/oai/',
		set: 'set to harvest, e.g. publication:lawreview',
		excludeSets: 'sets to skip (array)',
		skipPattern: 'regex: skip records whose title matches (covers, front matter, tables of contents…)',
		pdfPattern: 'regex identifying PDF URLs among dc:identifier (default: .pdf / viewcontent)',
		landingPattern: 'regex identifying the landing page among dc:identifier',
		landing: 'true: read citation_* metadata from the landing page (volume, issue, pages)',
	},

	async *discover(ctx) {
		let p = ctx.params;
		for await (let ref of JCOai.harvest(ctx, p)) {
			// Digital Commons article URLs carry volume and issue: …/slug/vol12/iss3/4
			let m = ref.url && /\/vol(\d+)\/iss(\w+)\/(\d+)/.exec(ref.url);
			if (m) {
				ref.meta.volume = ref.meta.volume || m[1];
				ref.meta.issue = ref.meta.issue || m[2];
			}
			// dc:source of Digital Commons is the collection name, not the journal
			delete ref.meta.pages;
			ref.landing = !!p.landing;
			yield ref;
		}
	},
});
