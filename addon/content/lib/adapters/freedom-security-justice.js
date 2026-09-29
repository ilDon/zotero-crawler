/* global JCAdapters, JCUtil */

/**
 * Freedom, Security & Justice: European Legal Studies (static site made with WebSite X5).
 * The home page menu links every issue newest first ("2026,-n.-2.html"); each issue page links
 * the article PDFs (files/…pdf). A title spread over several lines is several links to the same
 * PDF (sometimes the first one empty): the texts are joined, which the generic crawler cannot do.
 */
JCAdapters.register({
	id: 'freedom-security-justice',
	label: 'Freedom, Security & Justice',
	description: 'Issue pages from the home page menu; one ref per linked PDF, title = joined link texts.',
	params: {},

	async *discover(ctx) {
		let home = await ctx.getDoc('http://www.fsjeurostudies.eu/index.html');
		let issues = [];
		let seen = new Set();
		for (let a of home.querySelectorAll('a[href*=",-n.-"]')) {
			let url = JCUtil.absUrl(a.getAttribute('href'), home.__url);
			let m = url && /\/(\d{4}),-n\.-(\d+)/.exec(url);
			if (!m || seen.has(url)) continue;
			seen.add(url);
			issues.push({ url, year: +m[1], issue: m[2] });
		}
		issues.sort((a, b) => b.year - a.year || b.issue - a.issue);
		ctx.log(`FSJ: ${issues.length} issues`);
		for (let [i, issue] of issues.entries()) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(String(issue.year))) break;
			let issueKey = JCUtil.normalizeUrl(issue.url);
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(issue.url);
			let arts = new Map();
			for (let a of doc.querySelectorAll('a[href$=".pdf"], a[href$=".PDF"]')) {
				let pdf = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				if (!pdf) continue;
				let art = arts.get(pdf) || { pdf, parts: [] };
				let t = JCUtil.text(a);
				if (t) art.parts.push(t);
				arts.set(pdf, art);
			}
			for (let art of arts.values()) {
				let title = JCUtil.cleanTitle(art.parts.join(' ').replace(/\s+([,.:;?!])/g, '$1'));
				// a PDF linked only by an icon, or files of another issue left on the page
				if (title.length < 4) continue;
				yield {
					key: art.pdf,
					pdfUrl: art.pdf,
					meta: {
						title,
						date: String(issue.year),
						issue: issue.issue,
						publicationTitle: 'Freedom, Security & Justice: European Legal Studies',
						ISSN: '2532-2079',
					},
					issueKey,
					landing: false,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
});
