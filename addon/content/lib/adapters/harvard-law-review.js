/* global JCAdapters, JCUtil, JCWordPress */

/**
 * Harvard Law Review (harvardlawreview.org), WordPress.
 *
 * /wp-json is blocked (403) but the REST API answers at /?rest_route=. Print pieces are the
 * "posts" (articles, notes, recent/leading cases, book reviews, …), the online Forum is the
 * custom type "forum"; the blog is not included. Volume and issue come from the
 * "volumeissue" taxonomy (class_list: volumeissue-vol-139-no-8).
 *
 * The PDF ("139-Harv.-L.-Rev.-1918.pdf", named after the citation, so it also gives the
 * first page) and the authors are only on the article page: resolve() reads them there,
 * one request per new article. og:title carries a " Harvard Law Review" suffix, so the
 * REST title is kept.
 *
 * Incremental: after a complete crawl only posts published after the last one seen (minus
 * a margin) are requested.
 */
JCAdapters.register({
	id: 'harvard-law-review',
	label: 'Harvard Law Review',
	description: 'Print pieces (posts) and Forum through /?rest_route=; PDF and authors from the article page.',
	params: {
		base: 'site URL (default https://harvardlawreview.org)',
		types: 'REST routes to crawl (default ["posts", "forum"])',
	},

	async *discover(ctx) {
		let p = Object.assign({
			base: 'https://harvardlawreview.org',
			restRoute: true,
			perPage: 50,
			fieldsList: 'id,date,link,title,class_list,type',
		}, ctx.params);
		let state = ctx.state;
		state.lastDate = state.lastDate || {};
		for (let type of p.types || ['posts', 'forum']) {
			let after = null;
			if (state.complete && state.lastDate[type]) {
				let d = new Date(state.lastDate[type]);
				d.setUTCDate(d.getUTCDate() - (p.marginDays || 60));
				after = d.toISOString().slice(0, 19);
			}
			else if (ctx.since) {
				after = `${ctx.since - 1}-12-31T23:59:59`;
			}
			let newest = null;
			for await (let post of JCWordPress.posts(ctx, p, { type, after })) {
				if (ctx.cancelled) return;
				if (!newest) newest = post.date;
				if (ctx.tooOld(post.date)) break;
				let meta = {
					title: JCUtil.cleanTitle(JCUtil.stripTags(post.title && post.title.rendered)),
					date: (post.date || '').slice(0, 10),
				};
				let vi = (post.class_list || []).map(c => /^volumeissue-vol-(\d+)(?:-no-(\w+))?$/.exec(c)).filter(Boolean);
				let vol = vi.find(m => m[1]);
				let iss = vi.find(m => m[2]);
				if (vol) meta.volume = vol[1];
				if (iss) meta.issue = iss[2];
				if (type === 'forum') meta.publicationTitle = 'Harvard Law Review Forum';
				yield { key: post.link, url: post.link, meta, landing: false };
			}
			if (!ctx.cancelled && newest && (!state.lastDate[type] || newest > state.lastDate[type])) {
				state.lastDate[type] = newest;
			}
		}
		if (!ctx.cancelled) state.complete = true;
	},

	/** PDF, first page and authors from the article page */
	async resolve(ctx, ref) {
		let doc = await ctx.getDoc(ref.url);
		let a = doc.querySelector('.single-article__header-download-button a[href], a.has-icon-before-pdf[href]');
		let pdf = a && JCUtil.absUrl(a.getAttribute('href'), doc.__url);
		if (pdf) {
			ref.pdfUrl = pdf;
			let m = /Harv\.?-L\.?-Rev\.?-(?:F\.?-)?(\d+)\.pdf/i.exec(pdf);
			if (m) ref.meta.pages = m[1];
		}
		let names = [...doc.querySelectorAll('.single-article__authors-link')].map(e => JCUtil.text(e)).filter(Boolean);
		if (names.length) ref.meta.creators = names.map(n => JCUtil.parseName(n)).filter(Boolean);
	},
});
