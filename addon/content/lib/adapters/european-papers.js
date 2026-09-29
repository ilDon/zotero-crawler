/* global JCAdapters, JCUtil, JCCrawl */

/**
 * European Papers (Drupal 7). The e-Journal category (/category/e-journal) lists every
 * article newest first, 10 per page, with its posting date: it is crawled with the generic
 * list crawler. Article pages carry complete citation_* tags (DOI, pages, PDF), but
 * citation_volume is "2026 11" (year + volume): resolve() reads the page and fixes it.
 */
JCAdapters.register({
	id: 'european-papers',
	label: 'European Papers',
	description: 'e-Journal article list (newest first) + citation_* metadata of each article page.',
	params: {},

	defaults: {
		start: 'https://www.europeanpapers.eu/category/e-journal',
		articleSelector: 'article.node-teaser',
		titleSelector: 'h2.entry-title a',
		linkSelector: 'h2.entry-title a',
		authorsSelector: '.field-name-field-blog-author-link a',
		titlePattern: '(?<date>\\d{2}\\.\\d{2}\\.\\d{4})',
		nextSelector: 'li.pager-next a',
		skipPattern: '^(european forum \\(european papers|table of contents|cover)',
		landing: true,
	},

	async *discover(ctx) {
		yield* JCCrawl.list(ctx, { ...this.defaults, ...ctx.params });
	},

	async resolve(ctx, ref) {
		if (!ref.url) return;
		let doc = await ctx.getDoc(ref.url);
		let { meta, pdfUrl } = JCUtil.parseEmbeddedMeta(doc, doc.__url);
		let m = /^\s*(\d{4})\s+(\d+)\s*$/.exec(meta.volume || '');
		if (m) meta.volume = m[2];
		// citation_firstpage holds the whole range "1445–1459"
		if (meta.pages) meta.pages = meta.pages.replace(/^(\d+)\s*[–-]\s*(\d+)(?:-\1-\2)?$/, '$1-$2').replace(/^(\d+-\d+)-.*$/, '$1');
		ref.meta = JCUtil.mergeMeta(meta, ref.meta);
		if (pdfUrl) ref.pdfUrl = pdfUrl;
		ref.landing = false;
	},
});
