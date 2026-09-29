/* global JCAdapters, JCCrawl */

/**
 * Rivista trimestrale di scienza dell'amministrazione (rtsa.eu). A static site (not OJS): the
 * home page lists every issue since 2016, newest first, one paragraph per article with the PDF
 * link (title) and the DOI link (mEDRA, 10.32049/RTSA.<year>.<issue>.<n>).
 * This is the crawl adapter in list mode; the year and the issue number are taken from the PDF
 * file name (RTSA_<issue>_<year>_<author>.pdf), because a few issues have no DOI; the DOI link
 * of the paragraph becomes the item URL and key (the PDF link when there is no DOI).
 */
JCAdapters.register({
	id: 'trimestrale-scienza-amministrazione',
	label: 'Rivista trimestrale di scienza dell\'amministrazione (rtsa.eu)',
	description: 'rtsa.eu home page (all issues since 2016): one PDF per article, year/issue from the file name.',
	params: {
		start: 'page listing the articles (default https://rtsa.eu/)',
		skipPattern: 'regex: skip entries whose title matches',
	},

	async *discover(ctx) {
		let p = {
			start: 'https://rtsa.eu/',
			blockClosest: 'p',
			skipPattern: '^call for papers|^fascicolo completo|^indice\\b',
			titleSelector: 'a[href$=".pdf"]',
			linkSelector: 'a[href*="doi.org/10."]',
			...ctx.params,
		};
		for await (let ref of JCCrawl.list(ctx, p)) {
			// linkSelector points at the DOI link: ref.url (and key) is https://doi.org/10.32049/…
			let doi = (/doi\.org\/(10\.\d+\/\S+)$/.exec(ref.url || '') || [])[1];
			let m = /RTSA_(\d+)(s?)_((?:19|20)\d\d)[_.]/i.exec(ref.pdfUrl || '');
			if (m) {
				ref.meta.date = m[3];
				ref.meta.issue = m[1] + (m[2] ? ' (suppl.)' : '');
			}
			if (ctx.tooOld(ref.meta.date)) continue;
			if (doi) ref.meta.DOI = doi.replace(/[.,;]+$/, '');
			yield ref;
		}
	},
});
