/* global JCAdapters, JCUtil */

/**
 * McGill Law Journal / Revue de droit de McGill (lawjournal.mcgill.ca, WordPress; the REST
 * API answers 403).
 *
 * /issues/ lists every issue since 1952 (oldest first). An issue page has a header
 * "Volume 71 No 1 2026" and one article.mcgill-listing__article per contribution with type,
 * first page ("p. 203"), PDF link, title (h2 inside the link to the article page) and
 * authors (.info). The issue list gives no year, so the year comes from the issue page.
 */
JCAdapters.register({
	id: 'mcgill-law-journal',
	label: 'McGill Law Journal',
	description: 'Issue pages of lawjournal.mcgill.ca, newest first (title, authors, volume/issue/year, first page, PDF).',
	params: { base: 'site URL (default https://lawjournal.mcgill.ca)' },

	async *discover(ctx) {
		let base = (ctx.params.base || 'https://lawjournal.mcgill.ca').replace(/\/+$/, '');
		let doc = await ctx.getDoc(base + '/issues/');
		let urls = [];
		for (let a of doc.querySelectorAll('a[href*="/issue/"]')) {
			let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
			if (href && !urls.includes(href)) urls.push(href);
		}
		urls.reverse(); // the page lists the issues oldest first
		ctx.log(`${urls.length} issues`);
		for (let [i, url] of urls.entries()) {
			if (ctx.cancelled) return;
			let issueKey = JCUtil.normalizeUrl(url);
			if (await ctx.isIssueDone(issueKey)) continue;
			let page = await ctx.getDoc(url);
			let header = page.querySelector('.current-issue__header');
			// header text: "volume 71 No2 | Volume 71 N o 1 2026" (the first part links to the next issue)
			let htext = JCUtil.text(header ? header.textContent.replace(JCUtil.text(header.querySelector('a')), ' ') : '');
			let m = /volume\s*(\d+)\s*n\s*o\s*([\d-]+)\s*(\d{4})/i.exec(htext);
			let volume = m ? m[1] : '', issue = m ? m[2] : '', year = m ? m[3] : '';
			if (ctx.tooOld(year)) break;
			for (let art of page.querySelectorAll('article.mcgill-listing__article')) {
				let h2 = art.querySelector('h2');
				let link = h2 && h2.closest('a[href]');
				let pdf = art.querySelector('a[download][href], a[href$=".pdf"]');
				let title = JCUtil.text(h2);
				let pdfUrl = pdf && JCUtil.absUrl(pdf.getAttribute('href'), page.__url);
				if (!title || !pdfUrl) continue;
				if (/^(table of contents|table des mati[eè]res|index|masthead)\b/i.test(title)) continue;
				let pages = /p\.\s*(\d+(?:\s*[-–]\s*\d+)?)/.exec(JCUtil.text(art.querySelector('.controls')) || '');
				let info = art.querySelector('.info');
				let by = info ? JCUtil.text(info.textContent.replace(JCUtil.text(info.querySelector('span')), ' ')) : '';
				let type = JCUtil.text(art.querySelector('.type'));
				let meta = {
					title: JCUtil.cleanTitle(title),
					creators: by ? JCUtil.parseAuthors(by.replace(/\*/g, '').replace(/\s+et\s+/g, ', ')) : [],
					date: year,
					volume,
					issue,
					publicationTitle: 'McGill Law Journal',
					ISSN: '0024-9041',
				};
				if (pages) meta.pages = pages[1];
				if (type && !/^article$/i.test(type)) meta.extra = 'Type: ' + type;
				let url2 = link ? JCUtil.absUrl(link.getAttribute('href'), page.__url) : null;
				yield { key: url2 || pdfUrl, url: url2, pdfUrl, meta, issueKey, landing: false };
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
});
