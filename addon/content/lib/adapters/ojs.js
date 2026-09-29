/* global JCAdapters, JCUtil, JCOai */

/**
 * Open Journal Systems (2.x and 3.x).
 *
 * mode 'oai' (default): the journal's OAI-PMH endpoint gives title, authors, date, DOI,
 * volume/issue/pages and the galley link, so no page has to be visited.
 * mode 'archive': walks /issue/archive and the issue tables of contents, newest first,
 * skipping issues completed in earlier runs; metadata comes from each article page.
 */
var JCOjs = {
	/** …/article/view/123/456 (galley) → …/article/download/123/456 */
	galleyToDownload(u) {
		if (!u) return null;
		let m = /^(.*\/article\/)(?:view|viewFile|download)\/([^/]+)\/(\d+)(?:\/\d+)?\/?$/.exec(u);
		return m ? `${m[1]}download/${m[2]}/${m[3]}` : null;
	},

	async *oai(ctx, p) {
		let base = p.base.replace(/\/+$/, '');
		let endpoint = p.oai || base + '/oai';
		yield* JCOai.harvest(ctx, {
			endpoint,
			set: p.set,
			excludeSets: p.excludeSets,
			includeSets: p.includeSets,
			skipPattern: p.skipPattern,
			landingPattern: '/article/view/[^/]+/?$',
			pdfPattern: '/article/(download|viewFile)/[^/]+/\\d+',
			relationToPdf: u => this.galleyToDownload(u),
		});
	},

	async *archive(ctx, p) {
		let base = p.base.replace(/\/+$/, '');
		let issues = [];
		let seenIssue = new Set();
		for (let page = 1; page <= (p.maxArchivePages || 30) && !ctx.cancelled; page++) {
			let url = page === 1 ? `${base}/issue/archive` : `${base}/issue/archive/${page}`;
			let doc;
			try {
				doc = await ctx.getDoc(url);
			}
			catch (e) {
				if (page === 1) throw e;
				break;
			}
			let found = 0;
			for (let a of doc.querySelectorAll('a[href*="/issue/view/"]')) {
				let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				let m = href && /\/issue\/view\/(\d+)/.exec(href);
				if (!m || seenIssue.has(m[1])) continue;
				seenIssue.add(m[1]);
				let block = a.closest('.obj_issue_summary, li, tr, .issue-summary, .card') || a.parentElement;
				issues.push({ id: m[1], url: href.replace(/(\/issue\/view\/\d+).*$/, '$1'), label: JCUtil.text(block) });
				found++;
			}
			if (!found) break;
			// stop paging once issues are older than the cutoff
			let lastYear = JCUtil.yearOf(issues[issues.length - 1].label);
			if (ctx.since && lastYear && lastYear < ctx.since) break;
		}
		ctx.log(`OJS archive: ${issues.length} issues`);
		for (let [i, issue] of issues.entries()) {
			if (ctx.cancelled) return;
			let year = JCUtil.yearOf(issue.label);
			if (ctx.since && year && year < ctx.since) break;
			let issueKey = 'issue:' + issue.id;
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(issue.url);
			let articles = new Map();
			for (let a of doc.querySelectorAll('a[href*="/article/view/"]')) {
				let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				let m = href && /^(.*\/article\/view\/([^/?#]+))(?:\/(\d+))?/.exec(href);
				if (!m) continue;
				let art = articles.get(m[2]) || { url: m[1], pdfUrls: [], title: '' };
				if (m[3]) {
					let isPdf = /pdf/i.test(a.className + ' ' + JCUtil.text(a));
					let dl = this.galleyToDownload(href);
					if (dl) isPdf ? art.pdfUrls.unshift(dl) : art.pdfUrls.push(dl);
				}
				else if (!art.title) {
					art.title = JCUtil.text(a);
				}
				articles.set(m[2], art);
			}
			for (let art of articles.values()) {
				yield {
					key: art.url,
					url: art.url,
					pdfUrls: art.pdfUrls,
					meta: { title: JCUtil.cleanTitle(art.title) },
					issueKey,
					landing: true,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
};

JCAdapters.register({
	id: 'ojs',
	label: 'Open Journal Systems',
	description: 'OJS journals. mode "oai" (default) uses the OAI-PMH endpoint; "archive" walks the issue archive.',
	params: {
		base: 'journal URL, e.g. https://journals.example.edu/index.php/journal',
		mode: '"oai" (default) or "archive"',
		oai: 'OAI-PMH endpoint, if not <base>/oai',
		set: 'OAI set, if the endpoint serves several journals',
		excludeSets: 'OAI sets (journal:SECTION) to skip, e.g. ["journal:REC"]',
		skipPattern: 'regex: skip articles whose title matches',
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.base) throw new Error('params.base missing');
		if ((p.mode || 'oai') === 'oai') yield* JCOjs.oai(ctx, p);
		else yield* JCOjs.archive(ctx, p);
	},
});
