/* global JCAdapters, JCUtil, JCWordPress */

/**
 * Diritto e Politica dei Trasporti (dirittoepoliticadeitrasporti.it), WordPress.
 *
 * The journal's contributions are three custom post types in the REST API
 * (articoli-e-saggi, note-a-sentenza, rassegne-commenti-e-); the other types (casi e
 * questioni, giurisprudenza, normativa, materiali, studi e ricerche, novità bibliografiche)
 * are documentation, not articles. Every contribution exists twice, in Italian and in
 * English (/en/…), both linking the same PDF: posts are grouped by PDF and the Italian page
 * is kept. Full-issue posts ("Fascicolo I/2026", "Issue I/2026") are skipped.
 *
 * Post titles are "Author[, Author], Title" or "Author – Title"; the first paragraph of
 * the content cites the issue: "DIRITTO E POLITICA DEI TRASPORTI (ISSN 2612-5056), I/2026,
 * Parte I, p. 40 – 76". Post dates do not follow the issues (bulk re-publications), so the
 * date is the issue year.
 *
 * Incremental: after a complete crawl only posts published after the last one seen (minus
 * a margin) are requested.
 */
var JCDirittoTrasporti = {
	types: ['articoli-e-saggi', 'note-a-sentenza', 'rassegne-commenti-e-'],

	_particle: /^(d[aeiu]|de[il]|della|dello|dei|degli|delle|van|von|der|den|la|le|y|dos|das|do|d['’]\S*)$/i,

	isName(s) {
		let words = s.trim().split(/\s+/);
		if (!s.trim() || s.length > 50 || words.length > 6) return false;
		return words.every(w => this._particle.test(w) || /^[\p{Lu}][\p{L}'’.-]*$/u.test(w));
	},

	/** "A. Rossi, B. Bianchi, Titolo" / "A. Rossi – Titolo" → {authors[], title} */
	splitTitle(raw) {
		let dash = /^(.{3,160}?)\s+[–—]\s+(.+)$/.exec(raw);
		if (dash) {
			let names = dash[1].split(/\s*,\s*/);
			if (names.every(n => this.isName(n))) return { authors: names, title: dash[2] };
		}
		let parts = raw.split(/,\s+/);
		let i = 0;
		while (i < parts.length - 1 && this.isName(parts[i])) i++;
		return { authors: parts.slice(0, i), title: parts.slice(i).join(', ') };
	},

	/** Issue, year and pages from the citation line at the top of the content */
	citation(html) {
		let text = JCUtil.stripTags(html).slice(0, 400);
		let out = {};
		let m = /\b([IVX]+)\/((?:19|20)\d\d)\b/.exec(text) || /\b((?:19|20)\d\d),\s*Vol\.\s*([IVX]+)/.exec(text);
		if (m) {
			let roman = /^[IVX]+$/.test(m[1]);
			out.issue = roman ? m[1] : m[2];
			out.year = roman ? m[2] : m[1];
		}
		m = /\bpp?\.\s*([\dIVXLC]+)\s*[–-]\s*([\dIVXLC]+)/.exec(text);
		if (m) out.pages = `${m[1]}-${m[2]}`;
		return out;
	},
};

JCAdapters.register({
	id: 'diritto-politica-trasporti',
	label: 'Diritto e Politica dei Trasporti',
	description: 'Articoli e saggi, note a sentenza, rassegne/commenti/recensioni (REST custom post types), one item per PDF.',
	params: {
		base: 'site URL (default https://www.dirittoepoliticadeitrasporti.it)',
		types: 'REST routes of the journal sections (default: articoli-e-saggi, note-a-sentenza, rassegne-commenti-e-)',
	},

	async *discover(ctx) {
		let p = Object.assign({ base: 'https://www.dirittoepoliticadeitrasporti.it', perPage: 50 }, ctx.params);
		let state = ctx.state;
		let after = null;
		if (state.complete && state.lastDate) {
			let d = new Date(state.lastDate);
			d.setUTCDate(d.getUTCDate() - (p.marginDays || 60));
			after = d.toISOString().slice(0, 19);
		}
		else if (ctx.since) {
			after = `${ctx.since - 1}-12-31T23:59:59`;
		}
		// group the posts of all sections by PDF (Italian and English pages share it)
		let byPdf = new Map();
		let newest = null;
		for (let type of p.types || JCDirittoTrasporti.types) {
			for await (let post of JCWordPress.posts(ctx, p, { type, after })) {
				if (ctx.cancelled) return;
				if (!newest || post.date > newest) newest = post.date;
				let ref = JCWordPress.articleRef(ctx, post, p);
				let pdf = ref.pdfUrls[0];
				if (!pdf) continue;
				let raw = JCUtil.stripTags(post.title && post.title.rendered);
				if (/^(fascicolo|issue)\s+[IVX]+\s*\/\s*\d{4}/i.test(raw) || /\/Fascicolo[-_]/i.test(pdf)) continue;
				let isEn = /\/en\//.test(post.link);
				let prev = byPdf.get(pdf);
				if (prev && (prev.isEn === isEn || !prev.isEn)) continue;
				let { authors, title } = JCDirittoTrasporti.splitTitle(raw);
				let cit = JCDirittoTrasporti.citation(post.content && post.content.rendered);
				ref.key = pdf;
				ref.pdfUrls = [pdf];
				ref.meta.title = JCUtil.cleanTitle(title);
				ref.meta.creators = authors.map(a => JCUtil.parseName(a)).filter(Boolean);
				if (cit.year) ref.meta.date = cit.year;
				if (cit.issue) ref.meta.issue = cit.issue;
				if (cit.pages) ref.meta.pages = cit.pages;
				byPdf.set(pdf, { ref, isEn, postDate: post.date });
			}
		}
		let items = [...byPdf.values()].sort((a, b) => b.postDate.localeCompare(a.postDate));
		for (let { ref } of items) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(ref.meta.date)) continue;
			yield ref;
		}
		if (!ctx.cancelled) {
			state.complete = true;
			if (newest && (!state.lastDate || newest > state.lastDate)) state.lastDate = newest;
		}
	},
});
