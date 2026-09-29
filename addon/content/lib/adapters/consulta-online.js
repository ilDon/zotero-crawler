/* global JCAdapters, JCUtil */

/**
 * Consulta OnLine (giurcost.org): the journal is the "Studi" section, organised in fascicoli
 * (studi/STUDINEW<year>-<I|II|III>Q.html from 2015, studi/STUDINEW<year>.html 2000-2014),
 * listed on studi/index.html. A fascicolo page is Word HTML: author line, title linked to the
 * article (studi/<name>.pdf, older ones studi/<name>.htm), English title, "(dd-mm-yyyy)", abstract.
 * studi/<name>.pdf is a viewer page: the file is /contents/giurcost/studi/<name>.pdf.
 * Old HTML-only studies are converted to PDF from their web page.
 * Skipped: decisions, rubriche, "Speciali" and full-year PDFs, indexes.
 */
var JCGiurcost = {
	base: 'https://giurcost.org/',
	roman: { I: 1, II: 2, III: 3 },
	skip: /\/studi\/(index|studinew|collana|liber-amicorum|criteri|regolamento|codiceetico|contributi|speciale|materiali|e-consultaonline|indicenew|referenti)/i,

	/** Nearest non-empty text of the previous / next block elements */
	neighbour(el, dir, n = 4) {
		let out = [];
		let cur = el;
		while (cur && out.length < n) {
			cur = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
			if (!cur) break;
			let t = JCUtil.text(cur);
			if (t) out.push(t);
		}
		return out;
	},

	refs(ctx, doc, issue) {
		let refs = [];
		let seen = new Set();
		for (let a of doc.querySelectorAll('a[href]')) {
			let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
			if (!href) continue;
			let u = new URL(href);
			if (!/(^|\.)giurcost\.org$/.test(u.hostname) || !/^\/studi\/(pdf\/)?[^/]+\.(pdf|html?)$/i.test(u.pathname)) continue;
			if (this.skip.test(u.pathname)) continue;
			let url = this.base + u.pathname.slice(1);
			if (seen.has(url)) continue;
			let block = a.closest('p, td, li') || a.parentElement;
			// the title may span several links/lines inside its paragraph; old fascicoli: "Title PDF"
			let title = JCUtil.text(a);
			let bt = JCUtil.text(block).replace(/\s*\bPDF$/, '');
			if (bt.length < 600 && bt.length >= title.length) title = bt;
			if (title.length < 5) continue;
			seen.add(url);
			title = JCUtil.cleanTitle(title);
			let before = this.neighbour(block, -1, 1)[0] || '';
			let after = this.neighbour(block, 1, 3);
			let meta = { title, issue: issue.label, date: String(issue.year) };
			let d = after.map(t => /^\((\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\)$/.exec(t)).find(Boolean);
			if (d) {
				let y = d[3].length === 2 ? '20' + d[3] : d[3];
				meta.date = `${y}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
			}
			// the author line is in capitals: "ANTONIO RUGGERI", "SALVATORE ALOISIO - ROBERTO PINARDI"
			if (before && before === before.toUpperCase() && before.length < 150 && !/^(PARTE|STUDI|\d{4})/.test(before)) {
				meta.creators = before.split(/\s+[-–]\s+|\s*,\s*/).map(n => JCUtil.parseName(n)).filter(Boolean);
			}
			let ref = { key: url, url, meta, issueKey: issue.key, landing: false, pdfFromPage: false };
			if (/\.pdf$/i.test(url)) {
				ref.pdfUrl = this.base + 'contents/giurcost/' + u.pathname.slice(1);
			}
			else {
				ref.htmlToPdf = true;
			}
			refs.push(ref);
		}
		return refs;
	},
};

JCAdapters.register({
	id: 'consulta-online',
	label: 'Consulta OnLine (giurcost.org) - Studi',
	description: 'Fascicoli of the "Studi" section, newest first; PDFs from /contents/giurcost/studi/, old HTML studies as web pages.',
	params: {},

	async *discover(ctx) {
		let doc = await ctx.getDoc(JCGiurcost.base + 'studi/index.html');
		let issues = [];
		let seen = new Set();
		for (let a of doc.querySelectorAll('a[href*="STUDINEW"]')) {
			let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
			let m = href && /STUDINEW(\d{4})(?:-(I{1,3})Q)?\.html?$/i.exec(href);
			if (!m || seen.has(m[0])) continue;
			seen.add(m[0]);
			let n = m[2] ? JCGiurcost.roman[m[2].toUpperCase()] : 0;
			issues.push({
				url: JCGiurcost.base + 'studi/' + m[0],
				year: +m[1],
				label: m[2] ? `${m[1]}/${m[2].toUpperCase()}` : m[1],
				key: 'fasc:' + m[0].toUpperCase(),
				sort: +m[1] * 10 + n,
			});
		}
		issues.sort((a, b) => b.sort - a.sort);
		ctx.log(`Consulta OnLine: ${issues.length} fascicoli`);
		for (let [i, issue] of issues.entries()) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(String(issue.year))) break;
			if (await ctx.isIssueDone(issue.key)) continue;
			let idoc = await ctx.getDoc(issue.url);
			for (let ref of JCGiurcost.refs(ctx, idoc, issue)) yield ref;
			// the newest fascicolo grows during its four months
			if (i > 0) ctx.markIssueDone(issue.key);
		}
	},
});
