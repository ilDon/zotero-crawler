/* global JCAdapters, JCUtil, JCWordPress */

/**
 * Harvard International Law Journal (journals.law.harvard.edu/ilj), WordPress.
 *
 * The print issues are single WordPress pages or posts titled "Volume 67, Issue 2"
 * (pages for vol. 60 and 65-67, posts for vol. 54-64) that link one PDF per piece:
 * "<a>Title</a> By Author & Author". Vol. 45-53 (2004-2013) are instead one post per
 * article in the category "Print Archives" (id 123), each linking its PDF. The online
 * scholarship (essays, digest, symposia: HTML only) is not included.
 *
 * Volume N is year 1959 + N. Issues completed in earlier runs are skipped (the newest one
 * is re-read at every run); the closed 2004-2013 archive is read once.
 */
var JCHilj = {
	skip: /^(front\s*matter|forward|foreword|masthead|table of contents|contents|appendix|index)\b/i,

	/** {vol, issue, label} from an issue page title, or null */
	parseIssue(title) {
		let m = /^Vol(?:ume|\.)\s*(\d+)\s*,?\s*(.*)$/i.exec(title);
		if (!m) return null;
		let rest = m[2].trim();
		if (/masthead/i.test(rest)) return null;
		let im = /^Issue\s*(\d+)$/i.exec(rest);
		return { vol: +m[1], issue: im ? im[1] : rest.replace(/\s*(edition|issue)$/i, '').trim() || '', label: title };
	},

	/** Authors written after the PDF link ("By A & B", "– A") */
	authorsAfter(a) {
		let p = a.closest('p, li') || a.parentElement;
		let rest = JCUtil.text(p).slice(JCUtil.text(p).indexOf(JCUtil.text(a)) + JCUtil.text(a).length);
		let s = /^\s*[–—-]\s*(.+)$/.exec(rest) || /^\s*By\s+(.+)$/i.exec(rest);
		if (!s) {
			let next = p.nextElementSibling;
			let t = next ? JCUtil.text(next) : '';
			s = /^By\s+(.+)$/i.exec(t);
		}
		return s ? JCUtil.parseAuthors(s[1].replace(/\s+&\s+/g, ' and ')) : [];
	},
};

JCAdapters.register({
	id: 'harvard-international-law-journal',
	label: 'Harvard International Law Journal',
	description: 'Print issues (issue pages/posts listing the article PDFs) and the 2004-2013 per-article archive.',
	params: {
		base: 'site URL (default https://journals.law.harvard.edu/ilj)',
		oldArchive: 'false: skip the 2004-2013 per-article archive (category 123)',
	},

	async *discover(ctx) {
		let p = Object.assign({ base: 'https://journals.law.harvard.edu/ilj', perPage: 100 }, ctx.params);
		let issues = [];
		for (let type of ['pages', 'posts']) {
			let query = type === 'posts' ? { search: 'Volume' } : {};
			let q = { fields: true, fieldsList: 'id,date,link,title', perPage: 100 };
			for await (let item of JCWordPress.posts(ctx, Object.assign({}, p, q), { type, query })) {
				let iss = JCHilj.parseIssue(JCUtil.stripTags(item.title && item.title.rendered));
				if (iss) issues.push(Object.assign(iss, { id: item.id, type, link: item.link, date: item.date }));
			}
		}
		issues.sort((a, b) => b.vol - a.vol || String(b.issue).localeCompare(String(a.issue)) || b.date.localeCompare(a.date));
		// the same article may be linked from two places (issue page, 2013 per-article post)
		let seenPdf = new Set();
		let seenTitle = new Set();
		for (let [i, iss] of issues.entries()) {
			if (ctx.cancelled) return;
			let year = String(1959 + iss.vol);
			if (ctx.tooOld(year)) break;
			let issueKey = `${iss.type}:${iss.id}`;
			if (await ctx.isIssueDone(issueKey)) continue;
			let full = await ctx.getJSON(JCWordPress.api(p, `${iss.type}/${iss.id}`, { _fields: 'content' }));
			let doc = JCWordPress.parseContent(ctx, full.content && full.content.rendered, iss.link);
			for (let a of doc.querySelectorAll('a[href]')) {
				let pdf = JCUtil.absUrl(a.getAttribute('href'), iss.link);
				if (!pdf || !/\.pdf($|[?#])/i.test(pdf) || seenPdf.has(pdf)) continue;
				let title = JCUtil.cleanTitle(JCUtil.text(a));
				if (!title || title.length < 4 || JCHilj.skip.test(title) || /\/front\d|masthead|table-of-contents/i.test(pdf)) continue;
				seenPdf.add(pdf);
				seenTitle.add(JCUtil.normTitle(title));
				yield {
					key: pdf,
					pdfUrl: pdf,
					meta: { title, creators: JCHilj.authorsAfter(a), date: year, volume: String(iss.vol), issue: iss.issue },
					issueKey,
					landing: false,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
		// 2004-2013: one post per article (closed archive, read once)
		if (p.oldArchive === false || ctx.state.oldDone || (ctx.since && ctx.since > 2013)) return;
		for await (let post of JCWordPress.posts(ctx, p, { type: 'posts', query: { categories: '123' } })) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(post.date)) break;
			let ref = JCWordPress.articleRef(ctx, post, p);
			let pdf = ref.pdfUrls[0];
			if (!pdf || seenPdf.has(pdf) || seenTitle.has(JCUtil.normTitle(ref.meta.title))) continue;
			seenPdf.add(pdf);
			yield { key: pdf, pdfUrl: pdf, url: post.link, meta: ref.meta, landing: false };
		}
		if (!ctx.cancelled && !ctx.since) ctx.state.oldDone = true;
	},
});
