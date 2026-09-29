/* global JCAdapters, JCUtil */

/**
 * Ordine internazionale e diritti umani (rivistaoidu.net, WordPress + Flatsome).
 *
 * Every issue is a page ("Rivista OIDU n. 2/2026, 15 maggio 2026") whose table of contents is a
 * flat sequence h2.titoli_rivista (title), h3 (authors), "Download articolo" / "Download abstract"
 * links. The current issue is on the home page, older ones are linked from /numeri-precedenti/.
 * The "Osservatori" (case-law notes, one page per observatory listing every issue's notes as
 * "1. Title (Author)") are read too unless params.osservatori is false; a page is re-read only
 * when its REST "modified" date changes.
 */
var JCOidu = {
	base: 'https://www.rivistaoidu.net',

	/** "Rivista OIDU n. 2/2026, 15 maggio 2026" → {num, year, date} */
	parseLabel(label) {
		let m = /n\.?\s*(\d+)\s*\/\s*(\d{4})/i.exec(label || '');
		if (!m) return null;
		let date = JCUtil.parseDate(label.slice(m.index + m[0].length)) || m[2];
		if (JCUtil.yearOf(date) !== +m[2]) date = m[2];
		return { num: m[1], year: +m[2], date };
	},

	/** same page on www.rivistaoidu.net over https (the archive mixes hosts) */
	canonical(href) {
		let u = JCUtil.absUrl(href, this.base);
		if (!u) return null;
		let url = new URL(u);
		return this.base + url.pathname.replace(/\/?$/, '/');
	},

	authors(s) {
		s = JCUtil.text(s).replace(/^[•·\s]+/, '').replace(/\s+[–—-]\s+/g, ', ');
		return JCUtil.parseAuthors(s);
	},

	/** refs of one issue page (or the home page) */
	issueRefs(doc, issue) {
		let head = [...doc.querySelectorAll('h2.section-title')].find(h => /OIDU\s*n\.?\s*\d/i.test(JCUtil.text(h)));
		let root = (head && head.closest('.col-inner')) || doc.querySelector('#content') || doc;
		let refs = [];
		let cur = null;
		let flush = () => {
			if (cur && cur.pdfUrl && cur.title && !/^(indice|sommario|editoriale del direttore)$/i.test(cur.title)) {
				refs.push({
					key: cur.pdfUrl,
					pdfUrl: cur.pdfUrl,
					url: null,
					meta: { title: JCUtil.cleanTitle(cur.title), creators: cur.creators, date: issue.date, issue: issue.num },
					issueKey: issue.key,
				});
			}
			cur = null;
		};
		for (let el of root.querySelectorAll('h2.titoli_rivista, h3, a[href]')) {
			if (el.matches('h2')) {
				flush();
				cur = { title: JCUtil.text(el), creators: [], pdfUrl: null };
			}
			else if (el.matches('h3')) {
				if (cur && !cur.creators.length) cur.creators = this.authors(el);
			}
			else if (cur && !cur.pdfUrl) {
				let href = JCUtil.absUrl(el.getAttribute('href'), doc.__url);
				if (href && /\.pdf($|\?)/i.test(href) && !/abstract/i.test(JCUtil.text(el) + ' ' + href)) cur.pdfUrl = href;
			}
		}
		flush();
		return refs;
	},

	/** refs of an observatory page: h1.title "OSSERVATORIO … N. 1/2026", then "1. Title (Author)" paragraphs */
	osservatorioRefs(ctx, doc, key) {
		let refs = [];
		let issue = null;
		let root = doc.querySelector('#content') || doc;
		for (let el of root.querySelectorAll('h1, p')) {
			if (el.matches('h1')) {
				issue = this.parseLabel(JCUtil.text(el));
				continue;
			}
			let a = [...el.querySelectorAll('a[href]')].find(x => /\.pdf($|\?)/i.test(x.getAttribute('href') || ''));
			if (!a || !issue || ctx.tooOld(String(issue.year))) continue;
			let text = JCUtil.text(el);
			if (/intero osservatorio|^scarica/i.test(text)) continue;
			let m = /^\s*\d+\s*\.?\s*(.*?)\s*\(([^()]*)\)\s*[.,;]?\s*$/s.exec(text);
			let title = m ? m[1] : text.replace(/^\s*\d+\s*\.\s*/, '');
			let creators = m ? this.authors(m[2]) : [];
			if (!title || title.length < 5) continue;
			refs.push({
				key: JCUtil.absUrl(a.getAttribute('href'), doc.__url),
				pdfUrl: JCUtil.absUrl(a.getAttribute('href'), doc.__url),
				meta: { title: JCUtil.cleanTitle(title), creators, date: String(issue.year), issue: issue.num },
				issueKey: key,
			});
		}
		return refs;
	},
};

JCAdapters.register({
	id: 'ordine-internazionale-diritti-umani',
	label: 'Ordine internazionale e diritti umani (rivistaoidu.net)',
	description: 'Issue pages (home page + /numeri-precedenti/), one PDF per article; plus the Osservatori pages.',
	params: { osservatori: 'false to skip the Osservatori (case-law notes)' },

	async *discover(ctx) {
		let p = ctx.params;
		let base = JCOidu.base;
		// issues: current one on the home page, then the archive (newest first)
		let issues = [];
		let home = await ctx.getDoc(base + '/');
		let head = [...home.querySelectorAll('h2.section-title')].find(h => /OIDU\s*n\.?\s*\d/i.test(JCUtil.text(h)));
		let cur = head && JCOidu.parseLabel(JCUtil.text(head));
		if (cur) issues.push({ ...cur, url: base + '/', doc: home });
		let arch = await ctx.getDoc(base + '/numeri-precedenti/');
		for (let a of arch.querySelectorAll('#content a[href]')) {
			let label = JCUtil.text(a);
			let info = /oidu/i.test(label) && JCOidu.parseLabel(label);
			let url = info && JCOidu.canonical(a.getAttribute('href'));
			if (url) issues.push({ ...info, url });
		}
		let keys = new Set();
		let first = true;
		for (let issue of issues) {
			if (ctx.cancelled) return;
			issue.key = `${issue.year}-${issue.num}`;
			if (keys.has(issue.key)) continue;
			keys.add(issue.key);
			if (ctx.tooOld(String(issue.year))) break;
			let newest = first;
			first = false;
			if (await ctx.isIssueDone(issue.key)) continue;
			let doc = issue.doc || await ctx.getDoc(issue.url);
			for (let ref of JCOidu.issueRefs(doc, issue)) yield ref;
			if (!newest) ctx.markIssueDone(issue.key);
		}
		if (p.osservatori === false || ctx.cancelled) return;
		// Osservatori: one REST request tells which pages changed since they were last completed
		let pages = [];
		for (let n = 1; n < 10; n++) {
			let list = await ctx.getJSON(`${base}/wp-json/wp/v2/pages?per_page=100&page=${n}&_fields=id,link,modified`);
			pages.push(...list);
			if (list.length < 100) break;
		}
		for (let pg of pages) {
			if (ctx.cancelled) return;
			if (!/\/osservatori-[^/]+\/?$/.test(pg.link)) continue;
			let key = `oss:${new URL(pg.link).pathname}@${pg.modified}`;
			if (await ctx.isIssueDone(key)) continue;
			let doc = await ctx.getDoc(pg.link);
			for (let ref of JCOidu.osservatorioRefs(ctx, doc, key)) yield ref;
			ctx.markIssueDone(key);
		}
	},
});
