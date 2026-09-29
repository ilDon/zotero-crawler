/* global JCAdapters, JCUtil */

/**
 * Lexambiente – Rivista trimestrale di diritto penale dell'ambiente (Joomla).
 *
 * The current issue is only on the home page (blog layout, heading "Numero N-YYYY"); past
 * issues are all on /it/archivio.html, grouped by "YYYY-N". The PDF of each article is the
 * first PDF link in the article page body (the resolver finds it with landing: true).
 * Articles of the current issue change URL (/it/slug.html → /it/YYYY-N/slug.html) when the
 * issue is archived, so keys are built from issue + slug and stay stable.
 */
JCAdapters.register({
	id: 'lexambiente',
	label: 'Lexambiente trimestrale',
	description: 'Home page (current issue) and archive page of lexambientetrimestrale.it; one landing page per article for the PDF.',
	params: {
		base: 'site URL (default https://www.lexambientetrimestrale.it)',
	},

	async *discover(ctx) {
		let base = (ctx.params.base || 'https://www.lexambientetrimestrale.it').replace(/\/+$/, '');
		let slugOf = u => (u.split('/').pop() || '').replace(/\.html$/, '');
		let makeRef = (a, label, block) => {
			let url = JCUtil.absUrl(a.getAttribute('href'), base + '/it/');
			let title = JCUtil.cleanTitle(block.title);
			if (!url || !title || /^numero\s+\d/i.test(title)) return null;
			let [year, issue] = label.split('-');
			let meta = { title, date: year, issue, creators: block.authors ? JCUtil.parseAuthors(block.authors) : [] };
			return { key: `lexambiente:${label}/${slugOf(url)}`, url, meta, issueKey: label, landing: true, preferAdapterMeta: true };
		};

		// current issue: home page
		let home = await ctx.getDoc(base + '/it/');
		let lead = JCUtil.text(home.querySelector('.items-leading h2, .items-leading .page-header'));
		let m = /(\d+)\s*[-/]\s*(\d{4})/.exec(lead);
		if (m && !ctx.tooOld(m[2])) {
			let label = `${m[2]}-${m[1]}`;
			for (let item of home.querySelectorAll('.blog-items:not(.items-leading) .blog-item')) {
				let a = item.querySelector('.readmore a, h2 a');
				if (!a) continue;
				let au = item.querySelector('a[href*="/autori/"]');
				let ref = makeRef(a, label, { title: JCUtil.text(item.querySelector('h2')), authors: au && JCUtil.text(au) });
				if (ref) yield ref;
			}
		}

		// past issues: archive page, newest first
		let arch = await ctx.getDoc(base + '/it/archivio.html');
		for (let group of arch.querySelectorAll('ul.mod-list > li')) {
			if (ctx.cancelled) return;
			let label = JCUtil.text(group.querySelector('.mod-articles-category-group'));
			if (!/^\d{4}-\d+$/.test(label)) continue;
			if (ctx.tooOld(label.slice(0, 4))) break;
			if (await ctx.isIssueDone(label)) continue;
			for (let li of group.querySelectorAll('li')) {
				let a = li.querySelector('a.mod-articles-category-title');
				if (!a) continue;
				let by = JCUtil.text(li.querySelector('.mod-articles-category-writtenby'));
				let ref = makeRef(a, label, { title: JCUtil.text(a), authors: by && by !== '#' ? by : '' });
				if (ref) yield ref;
			}
			ctx.markIssueDone(label);
		}
	},
});
