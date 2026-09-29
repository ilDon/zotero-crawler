/* global JCAdapters, JCUtil */

/**
 * federalismi.it (ColdFusion site by Contech Lab).
 *
 * The journal is a sequence of numbered "fascicoli" (about 24 a year, since 2003), all listed
 * on one archive page (/nv14/archivio-rivista.cfm, links homepage.cfm?nrS=<n>). Every
 * fascicolo page lists the editorial (h1, editoriale.cfm?eid=) and the articles (h2,
 * articolo-documento.cfm?Artid=). The materials of the sections normativa/giurisprudenza/
 * documentazione and the "focus"/osservatori numbers are not crawled.
 *
 * PDFs are shown in a pdf.js viewer (/ApplOpenFilePDF.cfm?…&dfile=<file>.pdf) whose
 * DEFAULT_URL is the real file (/archivio/YYYYMM/<file>.pdf, /document/editoriale/<file>.pdf):
 * resolve() reads the article page and the viewer to get it. Free, no login needed.
 * Note: the server answers with an empty body to requests without Accept-Encoding: gzip.
 */
var JCFederalismi = {
	base: 'https://www.federalismi.it',

	/** Stable key/URL of an article or editorial link, without the descriptive query params */
	cleanUrl(href) {
		let m = /[?&]artid=(\d+)/i.exec(href);
		if (/articolo-documento\.cfm/i.test(href) && m) return `${this.base}/nv14/articolo-documento.cfm?Artid=${m[1]}`;
		m = /editoriale\.cfm\?(?:.*&)?eid=(\d+)/i.exec(href);
		if (m) return `${this.base}/nv14/editoriale.cfm?eid=${m[1]}`;
		return null;
	},

	/** "Numero 24 - 16 settembre 2026" / "Nr 24 - del 16/09/2026" → {issue, date} */
	parseIssueLabel(s) {
		let out = {};
		let m = /\b(?:numero|nr\.?|n\.)\s*(\d+)/i.exec(s || '');
		if (m) out.issue = m[1];
		out.date = JCUtil.parseDate(String(s || '').replace(/^.*?\b(?:numero|nr\.?)\s*\d+\s*-\s*/i, ''));
		return out;
	},
};

JCAdapters.register({
	id: 'federalismi-it',
	label: 'federalismi.it',
	description: 'Fascicoli of federalismi.it (editorial + articles, PDF from the pdf.js viewer), newest first, one fascicolo at a time.',
	params: {
		maxIssues: 'limit the number of fascicoli read in one run (default: all)',
		skipPattern: 'regex of titles to skip (default: the periodic "Osservatorio del …" digests)',
	},

	async *discover(ctx) {
		let F = JCFederalismi;
		let doc = await ctx.getDoc(`${F.base}/nv14/archivio-rivista.cfm?custom_header=01`);
		let issues = [];
		let seen = new Set();
		for (let a of doc.querySelectorAll('a[href*="nrS="]')) {
			let m = /[?&]nrS=(\d+)/.exec(a.getAttribute('href'));
			if (!m || seen.has(m[1])) continue;
			seen.add(m[1]);
			let post = a.closest('.main-post');
			let label = JCUtil.text(post && post.querySelector('.post-date'));
			issues.push({ nr: +m[1], label, ...F.parseIssueLabel(label) });
		}
		issues.sort((x, y) => y.nr - x.nr);
		ctx.log(`federalismi.it: ${issues.length} fascicoli`);
		let newestNr = issues.length ? issues[0].nr : 0;
		let read = 0;
		for (let issue of issues) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(issue.date)) break;
			let issueKey = 'nrS:' + issue.nr;
			if (await ctx.isIssueDone(issueKey)) continue;
			if (ctx.params.maxIssues && read++ >= ctx.params.maxIssues) break;
			let idoc = await ctx.getDoc(`${F.base}/nv14/homepage.cfm?nrS=${issue.nr}`);
			// the fascicolo page header ("Numero 24 - 16 settembre 2026") is more precise than the archive
			let head = idoc.querySelector('.category-title h3');
			let info = { ...issue, ...Object.fromEntries(Object.entries(F.parseIssueLabel(JCUtil.text(head))).filter(([, v]) => v)) };
			let found = new Set();
			let skip = new RegExp(ctx.params.skipPattern || '^osservatorio del\\b', 'i');
			for (let a of idoc.querySelectorAll('h1.h1_homepage a[href], h2.h2_homepage a[href]')) {
				let url = F.cleanUrl(a.getAttribute('href'));
				if (!url || found.has(url) || /hpsez=/i.test(a.getAttribute('href'))) continue;
				let title = JCUtil.cleanTitle(JCUtil.text(a));
				// the full-issue summary is itself an "article"; periodic digests of the osservatori
				if (!title || /^fascicolo\s+n\.?\s*\d+/i.test(title) || skip.test(title)) continue;
				found.add(url);
				// author line: after the h2 (in .entry-meta or .description), before the h1 of the editorial
				let h = a.closest('h1, h2');
				let authorEl = null;
				for (let sib of [h.nextElementSibling, h.previousElementSibling]) {
					let meta = sib && (sib.matches('.entry-meta') ? sib : sib.querySelector('.entry-meta'));
					authorEl = meta && meta.querySelector('.post-author b, .post-author strong');
					if (authorEl) break;
				}
				let authors = JCUtil.text(authorEl).replace(/\(a cura(?: di)?\)/i, '');
				let creators = authors && !/^(osservatorio|redazione|federalismi)\b/i.test(authors) ? JCUtil.parseAuthors(authors) : [];
				yield {
					key: url,
					url,
					meta: {
						title,
						creators,
						date: info.date || String(JCUtil.yearOf(info.label) || ''),
						issue: info.issue,
						publicationTitle: 'federalismi.it',
						ISSN: '1826-3534',
						language: 'it',
					},
					issueKey,
					landing: false,
				};
			}
			if (issue.nr !== newestNr) ctx.markIssueDone(issueKey);
		}
	},

	/** Article page → pdf.js viewer → real PDF path; abstract from the article page */
	async resolve(ctx, ref) {
		let F = JCFederalismi;
		let doc = await ctx.getDoc(ref.url);
		let a = doc.querySelector('a[href*="ApplOpenFilePDF.cfm"]');
		if (!ref.meta.abstractNote) {
			let h = doc.querySelector('h1.h1_homepage');
			let box = h && h.parentElement;
			let m = box && /Abstract \[It\]:\s*(.+?)(?:\s+Title:|\s+Abstract \[En\]:|\s+Parole chiave:|$)/s.exec(JCUtil.text(box));
			if (m && m[1].length > 40) ref.meta.abstractNote = m[1].trim();
		}
		if (!a) return;
		let viewer = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
		let cands = [];
		try {
			let html = await ctx.getText(viewer, { headers: { Referer: ref.url } });
			let m = /DEFAULT_URL\s*=\s*['"]([^'"]+)['"]/.exec(html);
			if (m) cands.push(JCUtil.absUrl(m[1], F.base));
		}
		catch (e) {
			ctx.warn(`federalismi viewer ${viewer}: ${e.message}`);
		}
		// fallback: the usual location of article PDFs
		let m = /dpath=document&(?:amp;)?dfile=((\d{2})(\d{2})(\d{4})\d+\.pdf)/i.exec(viewer);
		if (m) cands.push(`${F.base}/archivio/${m[4]}${m[3]}/${m[1]}`);
		ref.pdfUrls = [...new Set(cands)];
	},
});
