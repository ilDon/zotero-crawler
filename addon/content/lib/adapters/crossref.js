/* global JCAdapters, JCUtil */

/**
 * Discovery through the Crossref REST API (api.crossref.org/journals/<ISSN>/works): every
 * DOI registered for a journal, newest deposit first, with title, authors, date,
 * volume/issue/pages, abstract and license. Used directly (adapter 'crossref') and by the
 * publisher adapters built on it ('cambridge', 'mdpi').
 *
 * Incremental: after a complete run state.createdFrom keeps the run date (minus a margin)
 * and the next run asks only for DOIs deposited since then (filter from-created-date).
 * ctx.since becomes the filter from-pub-date.
 */
var JCCrossref = {
	API: 'https://api.crossref.org',

	SELECT: 'DOI,title,subtitle,author,published,issued,volume,issue,page,article-number,abstract,'
		+ 'license,link,resource,ISSN,container-title,type,created',

	/** Default: cover pages, front/back matter, corrections and other non-articles */
	SKIP: '(cover and (front|back) matter|^(front|back) matter|^erratum|^corrigend|^correction( to)?\\b|^retract'
		+ '|^expression of concern|^issue information|^editorial board|^reviewer acknowledg|^acknowledg(e)?ment to (the )?reviewers|^index\\b)',

	dateOf(d) {
		let p = d && d['date-parts'] && d['date-parts'][0];
		if (!p || !p[0]) return '';
		return p.map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join('-');
	},

	isOpen(item) {
		return (item.license || []).some(l => /creativecommons\.org|\/open-?access\b/i.test(l.URL || ''));
	},

	/** Crossref work → ref (meta from Crossref; the landing page is only read when opts.landing) */
	itemToRef(item, opts = {}) {
		let title = JCUtil.stripTags((item.title || [])[0] || '');
		let sub = JCUtil.stripTags((item.subtitle || [])[0] || '');
		if (sub && !title.toLowerCase().includes(sub.toLowerCase())) title += (/[?!.:]$/.test(title) ? ' ' : ': ') + sub;
		let creators = (item.author || []).map((a) => {
			if (a.family) return { firstName: a.given || '', lastName: a.family, creatorType: 'author' };
			return a.name ? { lastName: a.name, firstName: '', fieldMode: 1, creatorType: 'author' } : null;
		}).filter(Boolean);
		let abstract = JCUtil.stripTags(String(item.abstract || '').replace(/<jats:title>[^<]*<\/jats:title>/gi, ' '));
		let doi = item.DOI;
		let meta = {
			title: JCUtil.cleanTitle(title),
			creators,
			date: this.dateOf(item.published) || this.dateOf(item.issued),
			volume: item.volume || '',
			issue: item.issue || '',
			pages: item.page || item['article-number'] || '',
			DOI: doi,
			ISSN: (item.ISSN || [])[0] || '',
			publicationTitle: (item['container-title'] || [])[0] || '',
			abstractNote: abstract,
		};
		let resource = item.resource && item.resource.primary && item.resource.primary.URL;
		let pdfUrls = (item.link || [])
			.filter(l => /pdf/i.test(l['content-type'] || '') || /\/pdf\/?$|\.pdf($|\?)/i.test(l.URL || ''))
			.map(l => l.URL);
		return {
			key: 'https://doi.org/' + doi.toLowerCase(),
			url: resource || 'https://doi.org/' + doi,
			pdfUrls,
			meta,
			landing: !!opts.landing,
			preferAdapterMeta: true,
		};
	},

	/**
	 * Iterate the works of a journal (raw Crossref items), newest deposit first.
	 * opts: {issn, filter (extra Crossref filter string), rows}
	 */
	async *works(ctx, opts) {
		let state = ctx.state;
		let filters = ['type:journal-article'];
		if (opts.filter) filters.push(opts.filter);
		if (ctx.since) filters.push(`from-pub-date:${ctx.since}-01-01`);
		if (state.createdFrom) filters.push(`from-created-date:${state.createdFrom}`);
		let runStart = new Date();
		let cursor = '*';
		let n = 0;
		while (cursor && !ctx.cancelled) {
			let q = new URLSearchParams({
				filter: filters.join(','),
				sort: 'created',
				order: 'desc',
				rows: String(opts.rows || 100),
				cursor,
				select: this.SELECT,
			});
			if (opts.mailto) q.set('mailto', opts.mailto);
			let data = await ctx.getJSON(`${this.API}/journals/${encodeURIComponent(opts.issn)}/works?${q}`, { headers: { Accept: 'application/json' } });
			let msg = data && data.message;
			if (!msg || !msg.items || !msg.items.length) break;
			for (let item of msg.items) {
				n++;
				yield item;
				if (ctx.cancelled) return;
			}
			cursor = msg['next-cursor'];
			if (msg.items.length < (opts.rows || 100)) break;
		}
		if (!ctx.cancelled) {
			// two days of overlap: deposits are indexed with some delay
			runStart.setUTCDate(runStart.getUTCDate() - 2);
			state.createdFrom = runStart.toISOString().slice(0, 10);
		}
		ctx.log(`Crossref ${opts.issn}: ${n} works`);
	},

	/**
	 * Refs of a journal. opts: {issn, oaOnly, skipPattern, keywords, keywordFields, landing, rows, filter,
	 * transform(ref, item) → ref|null}
	 */
	async *refs(ctx, opts) {
		let skip = new RegExp(opts.skipPattern || this.SKIP, 'i');
		let kw = opts.keywords ? new RegExp(opts.keywords, 'i') : null;
		let fields = opts.keywordFields || ['title', 'abstract'];
		let stats = { closed: 0, skipped: 0, filtered: 0, yielded: 0 };
		for await (let item of this.works(ctx, opts)) {
			if (!item.DOI) continue;
			if (opts.oaOnly && !this.isOpen(item)) {
				stats.closed++;
				continue;
			}
			let ref = this.itemToRef(item, opts);
			if (!ref.meta.title || skip.test(ref.meta.title)) {
				stats.skipped++;
				continue;
			}
			if (kw) {
				let hay = fields.map(f => (f === 'title' ? ref.meta.title : f === 'abstract' ? ref.meta.abstractNote : '')).join(' \n ');
				if (!kw.test(hay)) {
					stats.filtered++;
					continue;
				}
			}
			if (ctx.tooOld(ref.meta.date)) continue;
			if (await ctx.isSeen(ref.key)) continue;
			if (opts.transform) ref = opts.transform(ref, item);
			if (!ref) continue;
			stats.yielded++;
			yield ref;
		}
		ctx.log(`Crossref: ${stats.yielded} new, ${stats.closed} not open access, ${stats.skipped} non-articles, ${stats.filtered} outside the keyword filter`);
	},
};

JCAdapters.register({
	id: 'crossref',
	label: 'Crossref (DOI metadata)',
	description: 'Lists a journal\'s DOIs through the Crossref API (newest first, incremental by deposit date); metadata from Crossref, PDF from the Crossref links or the landing page.',
	params: {
		issn: 'ISSN of the journal (any of print/online)',
		oaOnly: 'true: only works with a Creative Commons license (hybrid journals)',
		keywords: 'regex: keep only works whose title/abstract match (large multidisciplinary journals)',
		keywordFields: 'fields the keywords are matched against (default ["title","abstract"])',
		skipPattern: 'regex: skip works whose title matches (default: covers, front/back matter, errata)',
		landing: 'true: read citation_* tags (and citation_pdf_url) from the landing page',
		filter: 'extra Crossref filter, e.g. "has-license:true"',
		rows: 'page size (default 100, max 1000)',
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.issn) throw new Error('params.issn missing');
		yield* JCCrossref.refs(ctx, p);
	},
});
