/* global JCAdapters, JCUtil */

/**
 * Rivista di diritto dell'economia, dei trasporti e dell'ambiente (www.giureta.unipa.it).
 * Static pages exported from a word processor: the home page links one page per volume
 * (YYYY.html, plus supplements such as 2025/Supplemento_….html); each volume page lists the
 * articles as "Author, Title" linked to the PDF, often split over several <a> with the same
 * href. Links are grouped by PDF, author and title are split heuristically. Volumes before
 * 2009 have HTML articles only (no PDF) and yield nothing.
 * Incremental: volume pages completed in earlier runs are skipped (never the newest one).
 */
JCAdapters.register({
	id: 'diritto-economia-trasporti-ambiente',
	label: 'GIURETA (giureta.unipa.it)',
	description: 'Volume pages of giureta.unipa.it (one per year, plus supplements); one PDF per article.',
	params: {
		start: 'home page (default https://www.giureta.unipa.it/)',
		skipPattern: 'regex: skip entries whose title matches',
	},

	_names(s, minWords = 2) {
		s = s.replace(/[\s,;]+$/, '');
		let words = s.split(/\s+/);
		if (words.length < minWords || words.length > 16) return false;
		return words.every(w => /^[A-ZÀ-ÝŁŠŽČĆ'’][\p{L}'’.-]*,?$/u.test(w) || /^(de|di|da|del|della|van|von|e|and)$/i.test(w));
	},

	/** Text segments of the links of one PDF (one per link and per <br>), punctuation-only pieces dropped */
	_segments(links) {
		let segs = [];
		for (let a of links) {
			for (let h of String(a.innerHTML || '').split(/<br\s*\/?>/i)) {
				// inline tags split words ("<i>, L</i>a tutela"): remove them without adding spaces
				let t = JCUtil.text(JCUtil.decodeEntities(h.replace(/<[^>]*>/g, '')));
				if (t.replace(/[\s,;:.\-–]+/g, '')) segs.push(t);
			}
		}
		return segs;
	},

	/** Leading segments that look like names are the authors, the rest is the title */
	_split(segs) {
		let n = 0;
		while (n < segs.length - 1 && this._names(segs[n], n ? 1 : 2)) n++; // "Francesco Maria" + "Maffezzoni,"
		let authors = segs.slice(0, n).join(' ');
		let title = segs.slice(n).join(' ');
		if (!n) {
			let m = /^(.{3,160}?)(?:\s+[-–]\s+|\s*,\s*)(.+)$/su.exec(title);
			if (m && this._names(m[1])) {
				authors = m[1];
				title = m[2];
			}
		}
		title = JCUtil.text(title).replace(/^[\s,;:.\-–]+/, '');
		return { title, authors: authors.replace(/[\s,;]+$/, '') };
	},

	async *discover(ctx) {
		let p = ctx.params;
		let start = p.start || 'https://www.giureta.unipa.it/';
		let skip = new RegExp(p.skipPattern || 'fascicolo completo|^indice\\b|^sommario\\b|^copertina', 'i');
		let home = await ctx.getDoc(start);
		let pages = [];
		for (let a of home.querySelectorAll('a[href]')) {
			let u = JCUtil.absUrl(a.getAttribute('href'), home.__url);
			let m = u && /\/((?:19|20)\d\d)(?:\.html|\/Supplemento[^/]*\.html)$/i.exec(u);
			if (!m || pages.some(x => x.url === u)) continue;
			pages.push({ url: u, year: +m[1] });
		}
		// newest volume first, supplements after the volume of the same year
		pages.sort((a, b) => b.year - a.year || (/Supplemento/i.test(a.url) ? 1 : 0) - (/Supplemento/i.test(b.url) ? 1 : 0));
		ctx.log(`${pages.length} volume pages`);
		for (let [i, page] of pages.entries()) {
			if (ctx.cancelled) return;
			if (ctx.since && page.year < ctx.since) break;
			let issueKey = JCUtil.normalizeUrl(page.url);
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(page.url);
			let pageTitle = JCUtil.text(doc.querySelector('title'));
			let volume = (/vol(?:ume|\.)?\s+([IVXLC]+)\b/i.exec(pageTitle + ' ' + JCUtil.text(doc.body).slice(0, 300)) || [])[1] || '';
			let supp = /Supplemento/i.test(page.url) ? (/(Supplemento\s+n\.\s*\d+)/i.exec(JCUtil.text(doc.body)) || [])[1] || 'Supplemento' : '';
			let groups = new Map();
			for (let a of doc.querySelectorAll('a[href]')) {
				let u = JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				if (!u || !/\.pdf$/i.test(u)) continue;
				u = u.replace(/([^:])\/\/+/g, '$1/');
				if (!groups.has(u)) groups.set(u, []);
				groups.get(u).push(a);
			}
			for (let [pdfUrl, links] of groups) {
				let segs = this._segments(links);
				if (!segs.length) continue; // stray empty links to other volumes
				let { title, authors } = this._split(segs);
				title = JCUtil.cleanTitle(title);
				if (!title || title.length < 5 || skip.test(title)) continue;
				let d = /_(\d{2})(\d{2})((?:19|20)\d\d)\.pdf$/i.exec(pdfUrl);
				let y = /[/_-]((?:19|20)\d\d)\.pdf$/i.exec(pdfUrl);
				yield {
					key: pdfUrl,
					pdfUrl,
					meta: {
						title,
						creators: JCUtil.parseAuthors(authors),
						date: d ? `${d[3]}-${d[2]}-${d[1]}` : String(y ? y[1] : page.year),
						volume,
						issue: supp,
					},
					issueKey,
					landing: false,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
});
