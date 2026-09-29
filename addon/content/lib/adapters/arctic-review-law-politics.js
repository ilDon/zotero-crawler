/* global JCAdapters, JCUtil */

/**
 * Arctic Review on Law and Politics, on brill.com since 2025 (open access, Brill Nijhoff).
 *
 * One issue per volume (volume N = year 2009 + N): the table of contents is
 * /view/journals/arlp/<N>/1/arlp.<N>.issue-1.xml; articles of the running year are first
 * published in "Early view" (/view/journals/arlp/aop/issue.xml) and later moved to the volume
 * (new URL, same DOI: the plugin's DOI duplicate check avoids a second copy).
 * Metadata come from the article pages (citation_* tags); the PDFs are behind an AWS WAF
 * JavaScript challenge (the plugin's hidden browser is needed).
 * params: {code: 'arlp', yearOffset: 2009} so the same code can serve other Brill journals.
 */
JCAdapters.register({
	id: 'arctic-review-law-politics',
	label: 'Arctic Review on Law and Politics (Brill)',
	description: 'Brill journal: early-view list and yearly volume tables of contents; metadata from citation_* tags.',
	params: {
		code: 'Brill journal code (default "arlp")',
		yearOffset: 'volume N is year yearOffset + N (default 2009)',
		skipPattern: 'regex of titles to skip (default: front/back matter)',
	},

	async *discover(ctx) {
		let p = ctx.params;
		let code = p.code || 'arlp';
		let offset = p.yearOffset || 2009;
		let base = `https://brill.com/view/journals/${code}/`;
		let skip = new RegExp(p.skipPattern || '^(front matter|back matter|index|table of contents|erratum|corrigendum)', 'i');
		let thisYear = new Date().getFullYear();
		let issues = [{ key: 'aop', url: base + 'aop/issue.xml', year: thisYear, isNewest: true }];
		for (let vol = thisYear - offset; vol >= 1; vol--) {
			issues.push({ key: `vol:${vol}`, url: `${base}${vol}/1/${code}.${vol}.issue-1.xml`, year: offset + vol, vol });
		}
		let latestVolSeen = false;
		for (let issue of issues) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(String(issue.year))) break;
			if (await ctx.isIssueDone(issue.key)) continue;
			let res = await ctx.request(issue.url, { allowErrors: true });
			if (res.status === 404) continue; // volume of the running year not opened yet
			if (res.status >= 400) throw new Error(`HTTP ${res.status} ${issue.url}`);
			let doc = res.doc();
			let seen = new Set();
			let n = 0;
			for (let a of doc.querySelectorAll(`a[href*="/journals/${code}/"]`)) {
				let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				if (!href || !/\/article-[^/]+\.xml$/.test(href) || /downloadpdf/.test(href)) continue;
				if (issue.vol && !href.includes(`/${code}/${issue.vol}/`)) continue;
				if (!issue.vol && !href.includes(`/${code}/aop/`)) continue;
				if (seen.has(href)) continue;
				let title = JCUtil.text(a);
				if (!title || /^(download|pdf|view)/i.test(title)) continue;
				seen.add(href);
				if (skip.test(title)) continue;
				n++;
				let meta = { title: JCUtil.cleanTitle(title), date: String(issue.year) };
				if (issue.vol) Object.assign(meta, { volume: String(issue.vol), issue: '1' });
				else delete meta.date; // early view: date from the article page
				yield {
					key: href,
					url: href,
					pdfUrl: href.replace('/view/journals/', '/downloadpdf/view/journals/').replace(/\.xml$/, '.pdf'),
					meta,
					issueKey: issue.key,
					landing: true,
				};
			}
			ctx.log(`${issue.key}: ${n} articles`);
			// the early-view list and the running volume keep growing
			if (issue.vol) {
				if (latestVolSeen) ctx.markIssueDone(issue.key);
				latestVolSeen = true;
			}
		}
	},

	async resolve(ctx, ref) {
		// read the article page here: early-view pages carry volume "-1" and issue "aop"
		if (!ref.landing) return;
		let doc = await ctx.getDoc(ref.url);
		let { meta, pdfUrl } = JCUtil.parseEmbeddedMeta(doc, doc.__url);
		if (meta.volume === '-1' || meta.volume === '0') delete meta.volume;
		if (meta.issue === 'aop') delete meta.issue;
		if (/^(eng|en)$/i.test(meta.language || '')) meta.language = 'en';
		ref.meta = JCUtil.mergeMeta(meta, ref.meta);
		if (pdfUrl) ref.pdfUrl = pdfUrl;
		ref.landing = false;
	},
});
