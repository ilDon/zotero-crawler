/* global JCAdapters, JCUtil */

/**
 * Journal of Ethics and Legal Technologies (Padova University Press, Drupal 10).
 *
 * /issues lists the issues newest first ("JELT - Volume 8 Issue 1", "May 2026"); every issue
 * page lists its articles (/YYYY/N/M) with authors and pages. Article pages carry complete
 * citation_* tags (citation_pdf_url → /system/files/papers/…pdf), read with landing: true.
 */
JCAdapters.register({
	id: 'ethics-legal-technologies',
	label: 'JELT (Padova University Press)',
	description: 'Issue list and issue tables of contents of jelt.padovauniversitypress.it; metadata and PDF from citation_* tags.',
	params: {
		base: 'site URL (default https://jelt.padovauniversitypress.it)',
	},

	async *discover(ctx) {
		let base = (ctx.params.base || 'https://jelt.padovauniversitypress.it').replace(/\/+$/, '');
		let list = await ctx.getDoc(base + '/issues');
		let issues = [];
		for (let a of list.querySelectorAll('h3 a[href*="/issue/"]')) {
			let row = a.closest('li') || a.parentElement.parentElement;
			let label = JCUtil.text(a);
			let m = /volume\s+(\d+),?\s+issue\s+(\d+)/i.exec(label);
			issues.push({
				url: JCUtil.absUrl(a.getAttribute('href'), list.__url),
				date: JCUtil.parseDate(JCUtil.text(row.querySelector('.pubdate'))),
				volume: m ? m[1] : '',
				issue: m ? m[2] : '',
			});
		}
		ctx.log(`${issues.length} issues`);
		for (let [i, iss] of issues.entries()) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(iss.date)) break;
			let issueKey = JCUtil.normalizeUrl(iss.url);
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(iss.url);
			for (let li of doc.querySelectorAll('.item-list li')) {
				let a = li.querySelector('.views-field-title a[href]');
				if (!a) continue;
				let url = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				let pages = /pag\.\s*(\d+\s*-\s*\d+|\d+)/i.exec(JCUtil.text(li));
				yield {
					key: url,
					url,
					meta: {
						title: JCUtil.cleanTitle(JCUtil.text(a)),
						creators: JCUtil.parseAuthors(JCUtil.text(li.querySelector('.views-field-author-target-id'))),
						date: iss.date,
						volume: iss.volume,
						issue: iss.issue,
						pages: pages ? pages[1].replace(/\s+/g, '') : '',
					},
					issueKey,
					landing: true,
					preferAdapterMeta: true,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
});
