/* global JCAdapters, JCUtil */

/**
 * Configurable HTML crawler for sites without an API, in two shapes:
 *
 *  - issues: a page lists the issues (newest first, issueSelector); every issue page lists
 *    its articles (articleSelector). Issues completed in earlier runs are skipped.
 *  - list: the start page itself lists articles (no issueSelector), optionally paginated
 *    (nextSelector), newest first; the crawl stops at already seen articles.
 *
 * In an article block, the PDF link is pdfSelector (default: first link to a .pdf), the landing
 * page linkSelector, the title titleSelector (or the link text), the authors authorsSelector,
 * or titlePattern (regex with named groups title/authors/date) applied to the block text.
 */
var JCCrawl = {
	blockRefs(ctx, doc, p, extra = {}) {
		let base = doc.__url;
		let blocks;
		if (p.articleSelector) {
			blocks = [...doc.querySelectorAll(p.articleSelector)];
		}
		else {
			// one block per PDF link: its closest paragraph/list item
			blocks = JCUtil.pdfLinks(doc, base).map(l => l.el.closest(p.blockClosest || 'p, li, tr, div') || l.el);
		}
		let refs = [];
		let seen = new Set();
		for (let block of new Set(blocks)) {
			let pdfSel = p.pdfSelector || 'a[href$=".pdf"], a[href*=".pdf?"], a[href*=".PDF"]';
			let pdfEl = block.matches && (block.matches(pdfSel) || (!p.pdfSelector && block.matches('a[href]'))) ? block
				: block.querySelector(pdfSel);
			let linkEl = p.linkSelector ? block.querySelector(p.linkSelector) : null;
			let pdfUrl = pdfEl ? JCUtil.absUrl(pdfEl.getAttribute('href'), base) : null;
			let url = linkEl ? JCUtil.absUrl(linkEl.getAttribute('href'), base) : null;
			if (!pdfUrl && !url) continue;
			let key = url || pdfUrl;
			if (seen.has(key)) continue;
			seen.add(key);
			let text = JCUtil.text(block);
			let meta = {};
			if (p.titleSelector) {
				let t = block.querySelector(p.titleSelector);
				if (t) meta.title = JCUtil.text(t);
			}
			if (p.authorsSelector) {
				let a = [...block.querySelectorAll(p.authorsSelector)].map(e => JCUtil.text(e)).filter(Boolean);
				meta.creators = a.length === 1 ? JCUtil.parseAuthors(a[0]) : a.map(n => JCUtil.parseName(n)).filter(Boolean);
			}
			if (p.titlePattern) {
				let m = new RegExp(p.titlePattern, 'su').exec(text);
				if (m && m.groups) {
					if (m.groups.title && !meta.title) meta.title = JCUtil.text(m.groups.title);
					if (m.groups.authors && !(meta.creators || []).length) meta.creators = JCUtil.parseAuthors(m.groups.authors);
					if (m.groups.date) meta.date = JCUtil.parseDate(m.groups.date);
					if (m.groups.volume) meta.volume = m.groups.volume;
					if (m.groups.issue) meta.issue = m.groups.issue;
				}
			}
			if (!meta.title) meta.title = JCUtil.text(linkEl || pdfEl) || text;
			meta.title = JCUtil.cleanTitle(meta.title);
			if (!meta.title || meta.title.length < 4 || (p.skipPattern && new RegExp(p.skipPattern, 'i').test(meta.title))) continue;
			Object.assign(meta, Object.fromEntries(Object.entries(extra.meta || {}).filter(([k]) => !meta[k])));
			refs.push({
				key, url, pdfUrl, meta, issueKey: extra.issueKey,
				// without landing: the article page is still read when the PDF link is missing
				landing: p.landing && url ? true : undefined,
				preferAdapterMeta: !!p.preferListMeta,
			});
		}
		return refs;
	},

	async *issues(ctx, p) {
		let issues = [];
		let seen = new Set();
		let starts = Array.isArray(p.start) ? p.start : [p.start];
		for (let start of starts) {
			let url = start;
			for (let page = 0; url && page < (p.maxIssuePages || 20) && !ctx.cancelled; page++) {
				let doc = await ctx.getDoc(url, { browser: !!p.browser });
				for (let a of doc.querySelectorAll(p.issueSelector)) {
					let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
					if (!href || seen.has(href)) continue;
					if (p.issuePattern && !new RegExp(p.issuePattern).test(href)) continue;
					seen.add(href);
					issues.push({ url: href, label: JCUtil.text(a) || JCUtil.text(a.parentElement) });
				}
				let next = p.issueNext && doc.querySelector(p.issueNext);
				url = next ? JCUtil.absUrl(next.getAttribute('href'), doc.__url) : null;
			}
		}
		if (p.issuesOldestFirst) issues.reverse();
		ctx.log(`${issues.length} issues`);
		for (let [i, issue] of issues.slice(0, p.maxIssues || 10000).entries()) {
			if (ctx.cancelled) return;
			let date;
			if (p.issueDatePattern) {
				let m = new RegExp(p.issueDatePattern).exec(issue.label + ' ' + issue.url);
				date = m ? JCUtil.parseDate(m[1] || m[0]) : '';
			}
			else {
				date = JCUtil.parseDate(issue.label);
			}
			if (ctx.tooOld(date)) {
				if (p.stopAtOld !== false) break;
				continue;
			}
			let issueKey = JCUtil.normalizeUrl(issue.url);
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(issue.url, { browser: !!p.browser });
			let meta = {};
			if (date && p.dateFromIssue !== false) meta.date = date;
			if (p.issueFromLabel !== false) meta.issue = issue.label.slice(0, 80);
			for (let ref of this.blockRefs(ctx, doc, p, { issueKey, meta })) yield ref;
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},

	async *list(ctx, p) {
		let inc = ctx.incremental(p.stopAfterSeen || 20);
		let starts = Array.isArray(p.start) ? p.start : [p.start];
		for (let start of starts) {
			let url = start;
			for (let page = 0; url && page < (p.maxPages || 200) && !ctx.cancelled; page++) {
				let doc = await ctx.getDoc(url, { browser: !!p.browser });
				let refs = this.blockRefs(ctx, doc, p);
				let old = 0;
				for (let ref of refs) {
					if (ctx.tooOld(ref.meta.date)) {
						old++;
						continue;
					}
					if (await inc.seen(ref.key)) {
						if (inc.stop) return;
						continue;
					}
					yield ref;
				}
				if (refs.length && old === refs.length) break;
				let next = p.nextSelector && doc.querySelector(p.nextSelector);
				url = next ? JCUtil.absUrl(next.getAttribute('href'), doc.__url) : null;
			}
		}
		if (!ctx.cancelled) inc.complete();
	},
};

JCAdapters.register({
	id: 'crawl',
	label: 'HTML crawler (configurable)',
	description: 'Pages without an API: an issue list and issue tables of contents, or a paginated list of articles.',
	params: {
		start: 'URL (or array of URLs) of the issue list, or of the article list',
		issueSelector: 'CSS selector of the links to the issues on the start page (omit for an article list)',
		issuePattern: 'regex the issue URLs must match',
		issueNext: 'CSS selector of the "next page" link of the issue list',
		articleSelector: 'CSS selector of one article block (default: the paragraph around each PDF link)',
		titleSelector: 'CSS selector of the title inside the block',
		authorsSelector: 'CSS selector of the authors inside the block',
		linkSelector: 'CSS selector of the link to the article page inside the block',
		pdfSelector: 'CSS selector of the PDF link inside the block',
		titlePattern: 'regex with named groups title, authors, date, volume, issue applied to the block text',
		issueDatePattern: 'regex applied to the issue label and URL; its first group (or the match) is the date/year',
		preferListMeta: 'true: title and fields from the list win over the article page meta tags',
		skipPattern: 'regex: skip blocks whose title matches',
		nextSelector: 'article list: CSS selector of the "next page" link',
		landing: 'true: read citation_* metadata from the article page',
		landingPdfSelector: 'CSS selector of the PDF link on the article page, when the list has none',
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.start) throw new Error('params.start missing');
		if (p.issueSelector) yield* JCCrawl.issues(ctx, p);
		else yield* JCCrawl.list(ctx, p);
	},
});
