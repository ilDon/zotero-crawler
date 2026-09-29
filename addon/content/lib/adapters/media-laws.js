/* global JCAdapters, JCUtil, JCWordPress */

/**
 * MediaLaws – Rivista di diritto dei media (www.rivistadidirittodeimedia.it, WordPress).
 *
 * The journal (not the medialaws.eu blog, whose REST API is closed) publishes one post of
 * the custom type "mlrivista" per article (REST: /wp-json/wp/v2/mlrivista), with the issue
 * in the taxonomy rivista_category ("1/2026", "Special Issue II/2025", "Anteprime" = early
 * view) and the section in rivista_dettagli. The PDF ("Download PDF") and the author names
 * are rendered by the theme outside the REST content, so resolve() reads them from the
 * article page.
 *
 * Incremental: after a complete crawl only posts newer than the last one seen (minus a
 * margin) are requested.
 */
JCAdapters.register({
	id: 'media-laws',
	label: 'MediaLaws – Rivista di diritto dei media',
	description: 'mlrivista posts of rivistadidirittodeimedia.it via REST (issue from rivista_category); PDF and authors from the article page.',
	params: { base: 'site URL (default https://www.rivistadidirittodeimedia.it)' },

	async *discover(ctx) {
		let p = Object.assign({ base: 'https://www.rivistadidirittodeimedia.it' }, ctx.params);
		p.fieldsList = 'id,date,link,title,content,rivista_category,rivista_dettagli';
		let issues = new Map();
		try {
			let list = await ctx.getJSON(JCWordPress.api(p, 'rivista_category', { per_page: 100, _fields: 'id,name,slug' }));
			for (let c of list) issues.set(c.id, c);
		}
		catch (e) {
			ctx.warn('rivista_category: ' + e.message);
		}
		let state = ctx.state;
		let after = null;
		if (state.complete && state.lastDate) {
			let d = new Date(state.lastDate);
			d.setUTCDate(d.getUTCDate() - 60);
			after = d.toISOString().slice(0, 19);
		}
		else if (ctx.since) {
			after = `${ctx.since - 1}-12-31T23:59:59`;
		}
		let newest = null;
		let inc = ctx.incremental(30);
		for await (let post of JCWordPress.posts(ctx, p, { type: 'mlrivista', after })) {
			if (!newest) newest = post.date;
			if (ctx.tooOld(post.date)) break;
			if (await inc.seen(post.link)) {
				if (inc.stop) break;
				continue;
			}
			let ref = JCWordPress.articleRef(ctx, post, p);
			ref.pdfUrls = []; // links in the text are references, not the article
			let issue = (post.rivista_category || []).map(id => issues.get(id)).find(c => c && c.slug !== 'early-view');
			if (issue) {
				ref.meta.issue = issue.name;
				let y = /(\d{4})\s*$/.exec(issue.name);
				if (y && !ref.meta.date.startsWith(y[1])) ref.meta.date = y[1];
			}
			ref.meta.publicationTitle = 'MediaLaws – Rivista di diritto dei media';
			yield ref;
		}
		if (!ctx.cancelled) {
			inc.complete();
			if (newest && (!state.lastDate || newest > state.lastDate)) state.lastDate = newest;
		}
	},

	async resolve(ctx, ref) {
		if (!ref.url || (ref.pdfUrls && ref.pdfUrls.length)) return;
		let doc = await ctx.getDoc(ref.url);
		let a = doc.querySelector('.uncode-custom-button a[href$=".pdf"], a[href*="/wp-content/uploads/"][href$=".pdf"]');
		let href = a && JCUtil.absUrl(a.getAttribute('href'), doc.__url);
		if (href) ref.pdfUrls = [href];
		if (!(ref.meta.creators || []).length) {
			let names = [...doc.querySelectorAll('.author-info')].map(e => JCUtil.text(e)).filter(Boolean);
			ref.meta.creators = [...new Set(names)].flatMap(n => JCUtil.parseAuthors(n));
		}
	},
});
