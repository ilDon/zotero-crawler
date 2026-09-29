/* global JCAdapters, JCCrossref */

/**
 * MDPI journals (all open access, CC BY).
 *
 * www.mdpi.com answers "Access Denied" (Akamai) to plain HTTP clients and its OAI-PMH endpoint
 * (oai.mdpi.com) times out on list requests, so the article list and the metadata come from
 * Crossref (see crossref.js), newest first and incremental by deposit date. PDFs are taken from
 * MDPI's file server mdpi-res.com, which serves them without a bot check:
 *   https://mdpi-res.com/d_attachment/<journal>/<journal>-<vol:2>-<article:5>/article_deploy/<journal>-<vol:2>-<article:5>.pdf
 * with the www.mdpi.com /pdf link from Crossref as fallback (hidden browser in Zotero).
 *
 * Large multidisciplinary journals can be narrowed with
 * params.keywords, a regex matched against title and abstract.
 */
JCAdapters.register({
	id: 'mdpi',
	label: 'MDPI',
	description: 'MDPI journals: article list and metadata from Crossref, PDF from mdpi-res.com; optional keyword filter for large journals.',
	params: {
		issn: 'ISSN of the journal (print or online)',
		journal: 'MDPI journal code used in file names, e.g. "mathematics"',
		keywords: 'regex: keep only articles whose title/abstract match (for large journals)',
		keywordFields: 'fields the keywords are matched against (default ["title","abstract"])',
		skipPattern: 'regex: skip articles whose title matches (default: errata, retractions, reviewer acknowledgements)',
		rows: 'Crossref page size (default 100; up to 1000 for large journals)',
	},

	pdfUrl(journal, volume, article) {
		if (!journal || !/^\d+$/.test(volume || '') || !/^\d+$/.test(article || '')) return null;
		let id = `${journal}-${String(volume).padStart(2, '0')}-${String(article).padStart(5, '0')}`;
		return `https://mdpi-res.com/d_attachment/${journal}/${id}/article_deploy/${id}.pdf`;
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.issn) throw new Error('params.issn missing');
		let self = JCAdapters.get('mdpi');
		yield* JCCrossref.refs(ctx, {
			...p,
			landing: false,
			transform(ref, item) {
				let res = self.pdfUrl(p.journal, item.volume, item['article-number'] || item.page);
				if (res) ref.pdfUrls.unshift(res);
				ref.meta.itemType = 'journalArticle';
				return ref;
			},
		});
	},
});
