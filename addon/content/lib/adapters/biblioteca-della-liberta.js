/* global JCAdapters, JCUtil */

/**
 * Biblioteca della libertà (Centro Einaudi, Joomla), open access.
 *
 * Two sources:
 *  - "Online First Articles" (bdl-online-first-articles.html, 20 per page, newest first): since
 *    2025 the journal publishes article by article ("Bdl online"). Items whose URL has no issue
 *    path are taken from here; the article page gives DOI (10.23827/BDL_<year>_<n>) and PDF.
 *  - the issues (edizione-online.html, 10 per page, newest first; 2009-2025, n. 194-242): each
 *    issue page (6 articles per page, ?start=6…) lists title, authors, first page and PDF.
 * Issues completed in earlier runs are skipped; the stream stops at already seen articles.
 */
var JCBdl = {
	base: 'https://www.centroeinaudi.it/biblioteca-della-liberta/',

	blocks(doc) {
		return [...doc.querySelectorAll('.books.items > .row, .books .row')];
	},

	authors(block) {
		return [...block.querySelectorAll('.author a')].map(a => JCUtil.parseName(JCUtil.text(a))).filter(Boolean);
	},

	title(block) {
		let h = block.querySelector('h2.book-title, .book-title');
		if (!h) return '';
		let a = h.querySelector('a');
		let t = JCUtil.text(a || h);
		let small = !a && h.querySelector('p, small');
		if (small && JCUtil.text(small)) t = JCUtil.text(t.replace(JCUtil.text(small), ''));
		return JCUtil.cleanTitle(t);
	},

	async *stream(ctx) {
		let inc = ctx.incremental(10);
		for (let start = 0; start < 400 && !ctx.cancelled; start += 20) {
			let doc = await ctx.getDoc(`${this.base}bdl-online-first-articles.html${start ? '?start=' + start : ''}`);
			let blocks = this.blocks(doc);
			if (!blocks.length) break;
			let online = 0;
			for (let block of blocks) {
				let a = block.querySelector('.book-title a[href]');
				let url = a && JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				// articles already assigned to an issue are read from the issue pages
				if (!url || !/archivio-edizione-online-categoria\/\d+-[^/]+\.html$/.test(url)) continue;
				online++;
				if (await inc.seen(url)) {
					if (inc.stop) return;
					continue;
				}
				yield {
					key: url,
					url,
					meta: { title: this.title(block), creators: this.authors(block) },
					bdlOnline: true,
					landing: false,
				};
			}
			// online-first articles come first: stop at the first page without any
			if (!online) break;
		}
		if (!ctx.cancelled) inc.complete();
	},

	async *issues(ctx) {
		let issues = [];
		let seen = new Set();
		for (let start = 0; start < 200 && !ctx.cancelled; start += 10) {
			let doc = await ctx.getDoc(`${this.base}edizione-online.html${start ? '?start=' + start : ''}`);
			let n = 0;
			for (let a of doc.querySelectorAll('a[href*="archivio-edizione-online-categoria/"]')) {
				let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				let label = JCUtil.text(a);
				if (!href || !label || seen.has(href)) continue;
				seen.add(href);
				n++;
				issues.push({ url: href, label });
			}
			if (!n) break;
			let last = issues[issues.length - 1];
			if (ctx.since && JCUtil.yearOf(last.label) < ctx.since) break;
		}
		ctx.log(`Bdl: ${issues.length} issues`);
		for (let [i, issue] of issues.entries()) {
			if (ctx.cancelled) return;
			let date = JCUtil.parseDate(issue.label);
			if (ctx.tooOld(date)) break;
			let issueKey = 'issue:' + JCUtil.normalizeUrl(issue.url);
			if (await ctx.isIssueDone(issueKey)) continue;
			let m = /\bn\.?\s*(\d+)/i.exec(issue.label);
			let vol = /anno\s+([ivxlcdm]+)/i.exec(issue.label);
			let meta = { date, issue: m ? m[1] : '', volume: vol ? vol[1].toUpperCase() : '' };
			for (let start = 0; start < 60 && !ctx.cancelled; start += 6) {
				let doc = await ctx.getDoc(issue.url + (start ? '?start=' + start : ''));
				let blocks = this.blocks(doc);
				if (!blocks.length) break;
				for (let block of blocks) {
					let pdf = block.querySelector('dd.file a[href], a[href$=".pdf"]');
					let pdfUrl = pdf && JCUtil.absUrl(pdf.getAttribute('href'), doc.__url);
					let title = this.title(block);
					if (!pdfUrl || !title || /^(indice|table of contents|sommario|biographical notes|note biografiche|notizie sugli autori|gli autori)$/i.test(title)) continue;
					let page = block.querySelector('.badge');
					let pm = page && /(\d+)/.exec(JCUtil.text(page));
					yield {
						key: pdfUrl,
						pdfUrl,
						meta: Object.assign({ title, creators: this.authors(block), pages: pm ? pm[1] : '' }, meta),
						issueKey,
						landing: false,
					};
				}
				if (!doc.querySelector(`a[href*="?start=${start + 6}"]`)) break;
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
};

JCAdapters.register({
	id: 'biblioteca-della-liberta',
	label: 'Biblioteca della libertà (Centro Einaudi)',
	description: 'Online-first articles (article pages: DOI, PDF) and the issues 2009-2025 (issue pages with PDFs).',
	params: {},

	async *discover(ctx) {
		yield* JCBdl.stream(ctx);
		yield* JCBdl.issues(ctx);
	},

	async resolve(ctx, ref) {
		if (!ref.bdlOnline || ref.pdfUrl) return;
		let doc = await ctx.getDoc(ref.url);
		let root = doc.querySelector('.item-page') || doc;
		let pdf = root.querySelector('a[href$=".pdf"]');
		if (pdf) ref.pdfUrl = JCUtil.absUrl(pdf.getAttribute('href'), doc.__url);
		let m = /\b(10\.23827\/[^\s]+)/.exec(JCUtil.text(root));
		if (m) {
			ref.meta.DOI = m[1];
			let y = /_(\d{4})_/.exec(m[1]);
			if (y) ref.meta.date = y[1];
		}
		let abs = /Abstract\s+(.{40,}?)(?:\s+Keywords?\b|$)/s.exec(JCUtil.text(root));
		if (abs) ref.meta.abstractNote = abs[1].slice(0, 4000);
	},
});
