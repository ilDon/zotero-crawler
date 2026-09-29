/* global JCAdapters, JCUtil */

/**
 * Columbia Law Review (columbialawreview.org, WordPress with a "content" post type that is
 * not exposed in the REST API).
 *
 * The archive /content/ lists every piece newest first (print articles, notes, essays,
 * book reviews and CLR Forum pieces), 10 per page, each with title, authors,
 * "Vol. 126, No. 4" and a JSON-LD block with the posting date. The PDF is linked from the
 * article page (landing), which only has an og:title with the site name appended, so the
 * listing metadata is preferred.
 */
JCAdapters.register({
	id: 'columbia-law-review',
	label: 'Columbia Law Review',
	description: 'Archive /content/ (newest first), PDF from the article page; volume and issue from the listing.',
	params: {
		start: 'archive URL (default https://columbialawreview.org/content/)',
		maxPages: 'maximum number of archive pages per run (default 200)',
	},

	async *discover(ctx) {
		let p = ctx.params;
		let url = p.start || 'https://columbialawreview.org/content/';
		let inc = ctx.incremental(p.stopAfterSeen || 20);
		let done = false;
		for (let page = 0; url && page < (p.maxPages || 200) && !ctx.cancelled; page++) {
			let doc = await ctx.getDoc(url);
			let items = [...doc.querySelectorAll('article.loop-item')];
			let old = 0;
			for (let item of items) {
				let a = item.querySelector('.loop-item-title a[href]');
				let link = a && JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				if (!link) continue;
				let label = JCUtil.text(item.querySelector('.issue'));
				let m = /Vol\.?\s*(\d+)(?:,\s*No\.?\s*([\w-]+))?/i.exec(label);
				let ld = JCUtil.text(item.querySelector('script'));
				let posted = (/"datePublished":\s*"(\d{4}-\d\d-\d\d)/.exec(ld) || [])[1] || '';
				let meta = {
					title: JCUtil.cleanTitle(JCUtil.text(a)),
					// volume N of the Review is the year 1900 + N
					date: m ? String(1900 + +m[1]) : posted,
				};
				if (m) {
					meta.volume = m[1];
					if (m[2]) meta.issue = m[2];
				}
				let abs = JCUtil.text(item.querySelector('.loop-abstract'));
				if (abs.length > 120) meta.abstractNote = abs;
				if (ctx.tooOld(posted || meta.date)) {
					old++;
					continue;
				}
				if (await inc.seen(link)) {
					if (inc.stop) return;
					continue;
				}
				// the PDF (a.icon-file-pdf) is on the article page
				yield { key: link, url: link, meta, landing: true, preferAdapterMeta: true };
			}
			if (items.length && old === items.length) {
				done = true;
				break;
			}
			let next = doc.querySelector('a.loop-nav-last[href]');
			url = next ? JCUtil.absUrl(next.getAttribute('href'), doc.__url) : null;
			if (!url) done = true;
		}
		if (done && !ctx.cancelled) inc.complete();
	},
});
