/* global JCAdapters, JCUtil */

/**
 * Filosofia e questioni pubbliche / Philosophy and Public Issues (Giappichelli platform).
 * Archive → year pages (?anno_rivista=YYYY) → issue pages (Detail/view_html?id_newsletter=N,
 * one per issue since 2024) → article blocks (.riga-stile: title link, DOI, authors). The
 * article PDF (/f/articoli/…) is linked only from the article page, next to the issue index
 * and the full-issue PDF: resolve() picks the right one. Issues before 2024 exist only as
 * full-issue PDFs and are skipped.
 */
JCAdapters.register({
	id: 'filosofia-e-questioni-pubbliche',
	label: 'Filosofia e questioni pubbliche',
	description: 'Year pages → issues → articles; article PDF from the article page.',
	params: {},

	async *discover(ctx) {
		let base = 'https://www.fqpjournal.com';
		let arch = await ctx.getDoc(`${base}/Tool/NewsletterArchive/view_html`);
		let years = [...new Set([...arch.querySelectorAll('a[href*="anno_rivista="]')]
			.map(a => +(/anno_rivista=(\d{4})/.exec(a.getAttribute('href')) || [])[1]).filter(Boolean))]
			.sort((a, b) => b - a);
		let issues = [];
		for (let year of years) {
			if (ctx.cancelled) return;
			if (ctx.since && year < ctx.since) break;
			let ydoc = await ctx.getDoc(`${base}/Tool/NewsletterArchive/view_html?anno_rivista=${year}`);
			for (let a of ydoc.querySelectorAll('a[href*="id_newsletter="]')) {
				let id = +(/id_newsletter=(\d+)/.exec(a.getAttribute('href')) || [])[1];
				if (!id || issues.some(i => i.id === id)) continue;
				let title = a.getAttribute('title') || '';
				let n = /Issue\s+(\d+)/i.exec(JCUtil.text(a.closest('li') || a));
				issues.push({ id, year, date: JCUtil.parseDate(title) || String(year), issue: n ? n[1] : '' });
			}
		}
		issues.sort((a, b) => b.id - a.id);
		ctx.log(`FQP: ${issues.length} issues`);
		for (let [i, issue] of issues.entries()) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(issue.date)) continue;
			let issueKey = 'issue:' + issue.id;
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(`${base}/Tool/NewsletterArchive/Detail/view_html?id_newsletter=${issue.id}&anno_rivista=${issue.year}`);
			for (let box of doc.querySelectorAll('.riga-stile')) {
				let a = box.querySelector('h5 a[href*="/Article/Archive/index_html"]');
				if (!a) continue;
				let url = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				let ida = (/ida=(\d+)/.exec(url) || [])[1];
				let text = JCUtil.text(box);
				let doi = /DOI\s+(10\.\S+)/.exec(text);
				// "Name, Affiliation, City, Country" or "Name & Name"
				let au = JCUtil.text(box.querySelector('i'));
				// (affiliations follow the first comma; ';' separates affiliations, not authors)
				let creators = JCUtil.text(au.split(',')[0]).split(/\s+(?:&|and)\s+/).map(n => {
					// JCUtil.parseName takes an initial like "H." for an all-caps surname
					let parts = n.split(/\s+/);
					if (parts.length > 2 && parts.some(w => /^[A-Z]\.$/.test(w))) {
						return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1], creatorType: 'author' };
					}
					return JCUtil.parseName(n);
				}).filter(Boolean);
				yield {
					key: `${base}/Article/Archive/index_html?ida=${ida}`,
					url,
					meta: {
						title: JCUtil.cleanTitle(a.getAttribute('title') || JCUtil.text(a)),
						creators,
						date: issue.date,
						issue: issue.issue,
						DOI: doi ? doi[1] : '',
						publicationTitle: 'Philosophy and Public Issues - Filosofia e questioni pubbliche',
						ISSN: '2240-7987',
					},
					issueKey,
					landing: false,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},

	async resolve(ctx, ref) {
		let doc = await ctx.getDoc(ref.url);
		let a = doc.querySelector('a[href*="/f/articoli/"]');
		if (a) ref.pdfUrl = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
	},
});
