/* global JCAdapters, JCUtil */

/**
 * Aedon - Rivista di arti e diritto on line (il Mulino), static HTML site.
 *
 * risorse/prece.htm lists every issue (oldest first, archivio/<year>/<n>/index<n><yy>.htm);
 * each issue page is a table of contents: title (link to the HTML article), "di <authors>",
 * English title in brackets and, from 2019, "pp. x-y, DOI: 10.7390/…" with a link to
 * Rivisteweb, where the PDF is open access (https://www.rivisteweb.it/download/article/<DOI>).
 * Articles without DOI (1998-2019) exist only as HTML pages: they are marked htmlToPdf (the page is converted to PDF).
 */
var JCAedon = {
	base: 'https://aedon.mulino.it/',
	docTitle: /^(legge|l\.|d\.\s?m\.|d\.?p\.?r|dpr|dm |d\.?\s?lg|decreto|sentenza|ordinanza|cons(iglio|\.) di stato|cons\. st|corte|tar |regolamento|disegno di legge|testo unificato|ricorso|statuto|art\.|convenzione|parere|circolare|codice|schema di|norme tecniche|direttiva|regione|commissione|protocollo|accordo|intesa)/i,

	/** One ref per article link of an issue table of contents */
	tocRefs(doc, issue) {
		let refs = [];
		let seen = new Set();
		let issueDir = issue.url.replace(/[^/]*$/, '');
		let links = [...doc.querySelectorAll('a[href]')];
		let inDocs = false;
		// document order: the "Documenti"/"Documentazione" section (texts of laws, rulings) closes the TOC
		for (let a of doc.querySelectorAll('a[href], img[src], .sezione, .sezione_alta')) {
			if (!a.matches('a[href]')) {
				let label = a.matches('img') ? a.getAttribute('src') : JCUtil.text(a);
				if (/document/i.test(label)) inDocs = true;
				continue;
			}
			if (inDocs) break;
			let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
			if (!href) continue;
			href = href.replace(/^http:\/\/(www\.)?aedon/, 'https://aedon').replace('://www.aedon', '://aedon');
			if (!href.startsWith(issueDir) || !/\.html?$/i.test(href)) continue;
			if (/\/(index\d*|autor\w*|autori\w*)\.html?$/i.test(href)) continue;
			if (seen.has(href)) continue;
			let title = JCUtil.text(a);
			if (!title || title.length < 4) continue;
			seen.add(href);
			let block = a.closest('td, p, li') || a.parentElement;
			// text of the block that belongs to this link: from the link to the next article link
			let text = this.textAfter(block, a, links);
			let meta = { title: JCUtil.cleanTitle(title), date: String(issue.year), issue: issue.n };
			let m = /^\s*[,.]?\s*(?:di|a cura di)\s+(.+?)(?=\s*\[|\s*pp\.|\s*DOI|$)/i.exec(text);
			let editor = m && /a cura di/i.test(m[0]);
			if (m) meta.creators = JCUtil.parseAuthors(m[1].replace(/[,.\s]+$/, ''));
			m = /\[\s*(.+?)\s*\]/.exec(text);
			if (m && m[1].length > 3) meta.extra = 'English title: ' + JCUtil.text(m[1]);
			m = /\bpp?\.\s*(\d+(?:\s*[-–]\s*\d+)?)/.exec(text);
			if (m) meta.pages = m[1].replace(/\s+/g, '').replace('–', '-');
			m = /DOI:?\s*(10\.\d{4,9}\/[^\s,;]+)/i.exec(text);
			if (m) meta.DOI = m[1].replace(/[.,;]$/, '');
			meta.ISSN = '1127-1345';
			meta.publicationTitle = 'Aedon';
			if (editor && /osservatori/i.test(href)) meta.extra = [meta.extra, 'Osservatorio'].filter(Boolean).join('\n');
			// old issues mark the documents section inconsistently: texts of laws and rulings have no author
			if (!(meta.creators || []).length && !meta.DOI && JCAedon.docTitle.test(meta.title)) continue;
			let ref = { key: href, url: href, meta, issueKey: issue.key, landing: false, pdfFromPage: false };
			if (meta.DOI) ref.pdfUrl = 'https://www.rivisteweb.it/download/article/' + meta.DOI;
			else ref.htmlToPdf = true;
			refs.push(ref);
		}
		return refs;
	},

	/** Text following link a inside block, up to the next article link */
	textAfter(block, a, links) {
		let full = JCUtil.text(block);
		let t = JCUtil.text(a);
		let i = full.indexOf(t);
		let rest = i >= 0 ? full.slice(i + t.length) : full;
		// cut at the title of the next link in the same block
		for (let b of block.querySelectorAll('a[href]')) {
			if (b === a) continue;
			let bt = JCUtil.text(b);
			if (bt.length < 4 || /^pdf$/i.test(bt)) continue;
			let j = rest.indexOf(bt);
			if (j > 0) rest = rest.slice(0, j);
		}
		return rest;
	},
};

JCAdapters.register({
	id: 'aedon',
	label: 'Aedon (il Mulino)',
	description: 'Static HTML issues of Aedon; PDFs (from 2019) from Rivisteweb via DOI, older articles as web pages.',
	params: {},

	async *discover(ctx) {
		let doc = await ctx.getDoc(JCAedon.base + 'risorse/prece.htm');
		let issues = [];
		let seen = new Set();
		for (let a of doc.querySelectorAll('a[href*="archivio/"]')) {
			let href = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
			let m = href && /\/archivio\/(\d{4})\/([\d_]+)\/index\d+\.html?$/i.exec(href);
			if (!m) continue;
			let url = `${JCAedon.base}archivio/${m[1]}/${m[2]}/${href.replace(/^.*\//, '')}`;
			let key = `${m[1]}/${m[2]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			issues.push({ url, key: 'issue:' + key, year: +m[1], n: m[2].replace('_', '-'), sort: +m[1] * 100 + parseInt(m[2]) });
		}
		issues.sort((a, b) => b.sort - a.sort);
		ctx.log(`Aedon: ${issues.length} issues`);
		for (let [i, issue] of issues.entries()) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(String(issue.year))) break;
			if (await ctx.isIssueDone(issue.key)) continue;
			let idoc = await ctx.getDoc(issue.url);
			for (let ref of JCAedon.tocRefs(idoc, issue)) yield ref;
			if (i > 0) ctx.markIssueDone(issue.key);
		}
	},
});
