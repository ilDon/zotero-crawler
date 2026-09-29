/* global JCAdapters, JCUtil */

/**
 * Journals on Giappichelli's own platform (e.g. www.example-journal.it):
 *   /Tool/NewsletterArchive/view_html                      → years (…?anno_rivista=YYYY)
 *   year page                                              → issues (…/Detail/view_html?id_newsletter=N, dated dd/mm/yyyy)
 *   issue page                                             → articles (/Article/Archive/index_html?ida=…&idn=N): title, "di Author, affiliation"
 *   article page                                           → "pdf articolo" (images.<site>/f/articoli/….pdf)
 * No citation_* tags. Newest issue first; issues completed in earlier runs are skipped.
 * The article PDF link is read from the article page (one request per new article, in resolve()).
 * The oldest issues only have a whole-issue PDF: those articles get no PDF.
 */
JCAdapters.register({
	id: 'giappichelli',
	label: 'Giappichelli (piattaforma riviste)',
	description: 'Giappichelli journal sites (Tool/NewsletterArchive): years → issues → articles; PDF from the article page.',
	params: {
		base: 'site URL, e.g. https://www.example-journal.it',
		skipPattern: 'regex: skip articles whose title matches',
	},

	/** "di Mario Rossi, Università di X e Anna Bianchi, Y" → creators (affiliations dropped) */
	authors(s) {
		s = JCUtil.text(s).replace(/^\(?\s*di\s+/i, '').replace(/\)\s*$/, '');
		if (!s) return [];
		return s.split(/\s+e\s+(?=[A-ZÀ-Ý][\p{Ll}'’]+\s+[A-ZÀ-Ý])/u)
			.map(a => JCUtil.parseName(a.split(',')[0]))
			.filter(c => c && c.lastName && c.lastName.length < 40);
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.base) throw new Error('params.base missing');
		let base = p.base.replace(/\/+$/, '');
		let skip = p.skipPattern ? new RegExp(p.skipPattern, 'i') : null;
		let arch = await ctx.getDoc(`${base}/Tool/NewsletterArchive/view_html`);
		let years = [...new Set([...arch.querySelectorAll('a[href*="anno_rivista="]')]
			.map(a => +(/anno_rivista=(\d{4})/.exec(a.getAttribute('href')) || [])[1]).filter(Boolean))]
			.sort((a, b) => b - a);
		ctx.log(`${years.length} years`);
		let first = true;
		for (let year of years) {
			if (ctx.cancelled) return;
			if (ctx.since && year < ctx.since) break;
			let ydoc = await ctx.getDoc(`${base}/Tool/NewsletterArchive/view_html?anno_rivista=${year}`);
			let issues = new Map();
			for (let a of ydoc.querySelectorAll('a[href*="NewsletterArchive/Detail/view_html"]')) {
				let id = (/id_newsletter=(\d+)/.exec(a.getAttribute('href')) || [])[1];
				if (!id) continue;
				let is = issues.get(id) || { id, label: '', date: '' };
				let t = JCUtil.text(a);
				let d = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(t + ' ' + (a.getAttribute('title') || ''));
				if (d) is.date = JCUtil.parseDate(d[1]);
				if (/fascicolo|numero|supplemento/i.test(t)) is.label = t;
				issues.set(id, is);
			}
			let list = [...issues.values()].sort((a, b) => b.id - a.id);
			for (let issue of list) {
				if (ctx.cancelled) return;
				let isNewest = first;
				first = false;
				let issueKey = 'idn:' + issue.id;
				if (await ctx.isIssueDone(issueKey)) continue;
				let url = `${base}/Tool/NewsletterArchive/Detail/view_html?id_newsletter=${issue.id}&anno_rivista=${year}`;
				let doc = await ctx.getDoc(url);
				let num = (/(\d+)/.exec(issue.label) || [])[1] || '';
				let seen = new Set();
				for (let a of doc.querySelectorAll('a[href*="/Article/Archive/index_html"]')) {
					let ida = (/ida=(\d+)/.exec(a.getAttribute('href')) || [])[1];
					if (!ida || seen.has(ida)) continue;
					seen.add(ida);
					let title = JCUtil.cleanTitle(a.getAttribute('title') || JCUtil.text(a));
					if (!title || (skip && skip.test(title))) continue;
					let block = a.closest('.riga-stile') || a.parentElement;
					let byline = block ? [...block.querySelectorAll('i')].map(i => JCUtil.text(i)).find(t => /^\(?di\s/i.test(t)) : '';
					let artUrl = `${base}/Article/Archive/index_html?ida=${ida}&idn=${issue.id}&idi=-1&idu=-1`;
					yield {
						key: artUrl,
						url: artUrl,
						meta: {
							title,
							creators: this.authors(byline || ''),
							date: issue.date || String(year),
							issue: /supplemento/i.test(issue.label) ? issue.label : num,
							language: 'it',
						},
						issueKey,
						landing: false,
					};
				}
				if (!isNewest) ctx.markIssueDone(issueKey);
			}
		}
	},

	/** The article PDF is linked only from the article page */
	async resolve(ctx, ref) {
		if (ref.pdfUrl || !ref.url) return;
		let doc = await ctx.getDoc(ref.url);
		let a = doc.querySelector('a[href*="/f/articoli/"]');
		if (a) ref.pdfUrl = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
	},
});
