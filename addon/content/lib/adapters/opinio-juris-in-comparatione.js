/* global JCAdapters, JCUtil, JCWordPress */

/**
 * Opinio Juris in Comparatione (www.opiniojurisincomparatione.org, WordPress + Enfold).
 *
 * Issues and articles are custom post types ("issues", "articles") exposed in the REST API
 * but with empty content: the table of contents is rendered by the theme on the issue page
 * (div.single-article: section label + title linking the article page, authors, PDF).
 * The issue list comes from the REST API (newest first), each issue page is read once;
 * issues other than the newest are marked done. "PRE-PRINT" issues hold articles that later
 * appear in a regular issue under the same article URL (the key), so they are imported once.
 */
JCAdapters.register({
	id: 'opinio-juris-in-comparatione',
	label: 'Opinio Juris in Comparatione',
	description: 'REST list of the "issues" post type, then the table of contents of each issue page.',
	params: { base: 'site URL (default https://www.opiniojurisincomparatione.org)' },

	async *discover(ctx) {
		let p = Object.assign({ base: 'https://www.opiniojurisincomparatione.org' }, ctx.params);
		p.fieldsList = 'id,date,link,title';
		let first = true;
		for await (let post of JCWordPress.posts(ctx, p, { type: 'issues' })) {
			if (ctx.cancelled) return;
			let isNewest = first;
			first = false;
			if (ctx.tooOld(post.date)) break;
			let issueKey = 'issue:' + post.id;
			if (await ctx.isIssueDone(issueKey)) continue;
			let label = JCUtil.stripTags(post.title && post.title.rendered);
			let preprint = /pre-?print|online-first/i.test(label);
			let vm = /vol\.?\s*([\dIVX]+)\s*,?\s*(?:n\.?|no\.?)\s*([\dIVX]+)/i.exec(label);
			let year = (/(\d{4})/.exec(label) || [])[1] || (post.date || '').slice(0, 4);
			let doc = await ctx.getDoc(post.link);
			for (let art of doc.querySelectorAll('.single-article')) {
				let link = art.querySelector('.post-title a[href]');
				let pdf = art.querySelector('.row-pdf a[href]');
				if (!link || !pdf) continue;
				let em = link.querySelector('em');
				let title = JCUtil.text(link.textContent.replace(em ? em.textContent : '', ' '));
				if (!title) continue;
				let authorsEl = art.querySelector('.row-author');
				let by = authorsEl ? JCUtil.text(authorsEl.textContent).replace(/^authors?:\s*/i, '').replace(/\((eds?|a cura di)\.?\)/gi, '') : '';
				let meta = {
					title: JCUtil.cleanTitle(title),
					creators: by ? JCUtil.parseAuthors(by) : [],
					date: year,
					publicationTitle: 'Opinio Juris in Comparatione',
				};
				if (!preprint) {
					if (vm) {
						meta.volume = vm[1];
						meta.issue = vm[2];
					}
					else {
						meta.issue = label.replace(/^opinio juris in comparatione,?\s*/i, '').slice(0, 80);
					}
				}
				let url = JCUtil.absUrl(link.getAttribute('href'), doc.__url);
				yield { key: url, url, pdfUrl: JCUtil.absUrl(pdf.getAttribute('href'), doc.__url), meta, issueKey, landing: false };
			}
			if (!isNewest) ctx.markIssueDone(issueKey);
		}
	},
});
