/* global JCAdapters, JCUtil */

/**
 * Cammino Diritto (rivista.camminodiritto.it, custom ASP site), open access.
 *
 * The list of all contributions is the sitemap (sitemap-xml.asp: articolo.asp?id=N with lastmod),
 * read in one request; ids grow with publication, so they are walked newest first and the walk
 * stops at already seen articles. Each article page has citation_* tags (date, authors, PDF
 * /public/pdfarticoli/<id>_<month>-<year>.pdf) but citation_title is cut at 80 characters:
 * the full title is the page's h1.doc-t.
 * The quarterly issue PDFs (scaricafascicolo.asp) are for registered users only and are not used.
 */
JCAdapters.register({
	id: 'cammino-diritto',
	label: 'Cammino Diritto',
	description: 'All contributions from the sitemap, newest first; metadata and PDF from the article pages.',
	params: {},

	async *discover(ctx) {
		let base = 'https://rivista.camminodiritto.it/';
		let xml = await ctx.getXML(base + 'sitemap-xml.asp');
		let items = [];
		for (let u of JCAdapters.xml(xml, 'url')) {
			let loc = JCAdapters.xmlText(u, 'loc');
			let m = /articolo\.asp\?id=(\d+)$/.exec(loc);
			if (!m) continue;
			items.push({ id: +m[1], url: `${base}articolo.asp?id=${m[1]}`, lastmod: JCAdapters.xmlText(u, 'lastmod') });
		}
		items.sort((a, b) => b.id - a.id);
		ctx.log(`Cammino Diritto: ${items.length} articles in the sitemap`);
		let inc = ctx.incremental(30);
		for (let it of items) {
			if (ctx.cancelled) return;
			// lastmod is never earlier than the publication date: safe for the cutoff
			if (ctx.tooOld(it.lastmod)) continue;
			if (await inc.seen(it.url)) {
				if (inc.stop) return;
				continue;
			}
			yield { key: it.url, url: it.url, meta: {}, landing: true };
		}
		if (!ctx.cancelled) inc.complete();
	},

	async resolve(ctx, ref) {
		if (!ref.landing) return;
		let doc = await ctx.getDoc(ref.url);
		let { meta, pdfUrl } = JCUtil.parseEmbeddedMeta(doc, doc.__url);
		let h1 = doc.querySelector('h1.doc-t, h1');
		if (h1 && JCUtil.text(h1).length >= (meta.title || '').length) meta.title = JCUtil.cleanTitle(JCUtil.text(h1));
		// citation_volume is the year and citation_issue the month
		delete meta.volume;
		delete meta.issue;
		meta.publicationTitle = 'Cammino Diritto';
		if (meta.abstractNote && meta.abstractNote.length < 100) delete meta.abstractNote;
		ref.meta = JCUtil.mergeMeta(ref.meta, meta);
		if (pdfUrl) ref.pdfUrl = pdfUrl;
		ref.landing = false;
		if (!pdfUrl) ref.htmlToPdf = true;
	},
});
