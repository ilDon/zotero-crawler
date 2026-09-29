/* global JCAdapters, JCUtil */

/**
 * European Review of Digital Administration & Law (ERDAL, Aracne editrice).
 * The home page lists the issues newest first ("Volume 7 – Issue 1 – 2026"); every issue page
 * lists its articles (.pubblicazione-estratto-container: authors, title, DOI, pages) with a
 * free PDF (/free-download/<isbn><n>.pdf). Full issue and table of contents are skipped.
 * (The generic crawler cannot be used: the issue links also contain the ISBN, whose digits
 * look like a year, e.g. 979-12-218-2045-4.)
 */
JCAdapters.register({
	id: 'european-review-digital-administration',
	label: 'ERDAL (erdalreview.eu)',
	description: 'Issues from the home page, articles and free PDFs from the issue pages.',
	params: {},

	async *discover(ctx) {
		let base = 'https://www.erdalreview.eu/';
		let home = await ctx.getDoc(base);
		let issues = [];
		let seen = new Set();
		for (let a of home.querySelectorAll('a[href*="/pubblicazioni/european-review"]')) {
			let url = JCUtil.absUrl(a.getAttribute('href'), home.__url);
			let m = /Volume\s+(\w+)\s*[–-]\s*Issue\s+([\w-]+)\s*[–-]\s*(\d{4})/i.exec(JCUtil.text(a));
			if (!url || !m || seen.has(url)) continue;
			seen.add(url);
			issues.push({ url, volume: m[1], issue: m[2], year: +m[3] });
		}
		ctx.log(`ERDAL: ${issues.length} issues`);
		for (let [i, issue] of issues.entries()) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(String(issue.year))) break;
			let issueKey = JCUtil.normalizeUrl(issue.url);
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(issue.url);
			for (let box of doc.querySelectorAll('.pubblicazione-estratto-container')) {
				let t = box.querySelector('.pubblicazione-estratto-titolo');
				let link = t && t.querySelector('a[href]');
				let pdf = box.querySelector('a[href*="free-download"]');
				let title = JCUtil.cleanTitle(JCUtil.text(t));
				if (!title || !pdf || /^(table of contents|indice)|\bfull issue$/i.test(title)) continue;
				// some articles have no abstract page: the PDF is the key for all of them
				let pdfUrl = JCUtil.absUrl(pdf.getAttribute('href'), doc.__url);
				let url = link ? JCUtil.absUrl(link.getAttribute('href'), doc.__url) : null;
				let doi = /DOI:\s*(10\.\S+)/.exec(JCUtil.text(box.querySelector('.pubblicazione-estratto-doi')));
				let pages = /(\d+\s*-\s*\d+)/.exec(JCUtil.text(box.querySelector('.pubblicazione-estratto-pagine')));
				yield {
					key: pdfUrl,
					url,
					pdfUrl,
					meta: {
						title,
						creators: [...box.querySelectorAll('.pubblicazione-estratto-autori-link')].map(e => JCUtil.parseName(JCUtil.text(e))).filter(Boolean),
						date: String(issue.year),
						volume: issue.volume,
						issue: issue.issue,
						pages: pages ? pages[1].replace(/\s+/g, '') : '',
						DOI: doi ? doi[1] : '',
						publicationTitle: 'European Review of Digital Administration & Law',
						ISSN: '2724-5969',
					},
					issueKey,
					landing: false,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
});
