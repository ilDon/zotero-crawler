/* global JCAdapters, JCCrawl */

/**
 * Rivista trimestrale di diritto dell'economia (Fondazione Gerardo Capriglione, LUISS).
 * rtde.luiss.it redirects to www.fondazionecapriglione.luiss.it/index_file/Page860.htm, a single
 * page that links one PDF per issue (numbers and supplements, 2012 onwards): the journal does
 * not publish separate article PDFs, so every issue is imported as one item.
 * This is the crawl adapter in list mode with one fix: the PDF links are http:// and the
 * server's http→https redirect is broken (".../it2026_02_RTDE.pdf"), so they are rewritten to https.
 */
JCAdapters.register({
	id: 'trimestrale-diritto-delleconomia',
	label: 'Rivista trimestrale di diritto dell\'economia (fascicoli)',
	description: 'One item per issue PDF from the issue list page of fondazionecapriglione.luiss.it (crawl in list mode, links forced to https).',
	params: {
		start: 'issue list page (default https://www.fondazionecapriglione.luiss.it/index_file/Page860.htm)',
		skipPattern: 'regex: skip links whose text matches',
		titlePattern: 'crawl titlePattern (default: link text up to the year, which is also the date)',
	},

	async *discover(ctx) {
		let p = {
			start: 'https://www.fondazionecapriglione.luiss.it/index_file/Page860.htm',
			skipPattern: 'obiettivi|compiti|codice etico|organi editoriali',
			titlePattern: '^(?<title>.*?(?<date>(?:19|20)\\d\\d))',
			...ctx.params,
		};
		for await (let ref of JCCrawl.list(ctx, p)) {
			ref.pdfUrl = ref.pdfUrl.replace(/^http:\/\//i, 'https://');
			let m = /^(?:(\w+)\s+)?supplemento al n\.?\s*(\d+)/i.exec(ref.meta.title);
			let n = /^numer[oi]\s+([\d-]+)/i.exec(ref.meta.title);
			ref.meta.issue = m ? `${m[2]} (${m[1] ? m[1].toLowerCase() + ' ' : ''}suppl.)` : n ? n[1] : '';
			ref.meta.title = `Rivista trimestrale di diritto dell'economia, ${ref.meta.title}`;
			ref.meta.itemType = 'journalArticle';
			yield ref;
		}
	},
});
