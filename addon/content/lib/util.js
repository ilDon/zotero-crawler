/* exported JCUtil */

/**
 * Helpers shared by the crawler core and the site adapters. Only standard web
 * APIs (URL, TextDecoder, DOM) are used, so this file also runs under Node for
 * the adapter test harness (see test/harness.mjs).
 */
var JCUtil = {
	/** Absolute URL of href relative to base, or null */
	absUrl(href, base) {
		if (!href) return null;
		href = String(href).trim();
		if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith('#')) return null;
		try {
			return new URL(href, base).href;
		}
		catch (e) {
			return null;
		}
	},

	/** URL used as a stable key: no fragment, no tracking parameters, no trailing slash, host without www */
	normalizeUrl(u) {
		try {
			let url = new URL(u);
			url.hash = '';
			url.protocol = 'https:';
			url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
			for (let p of [...url.searchParams.keys()]) {
				if (/^(utm_|fbclid|gclid|srsltid)/i.test(p)) url.searchParams.delete(p);
			}
			let s = url.href;
			if (s.endsWith('/') && url.pathname !== '/') s = s.slice(0, -1);
			return s;
		}
		catch (e) {
			return String(u || '').trim();
		}
	},

	/** Text of an element (or string) with collapsed whitespace */
	text(el) {
		if (el == null) return '';
		let s;
		if (typeof el === 'string') s = el;
		// <br> separates words ("Reassessing<br>the")
		else if (el.querySelector && el.querySelector('br')) s = this.decodeEntities(el.innerHTML.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''));
		else s = el.textContent;
		return String(s || '').replace(/[\s ​]+/g, ' ').trim();
	},

	decodeEntities(s) {
		return String(s || '')
			.replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
			.replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
			.replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
			.replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
			.replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
			.replace(/&hellip;/g, '…').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
			.replace(/&amp;/g, '&');
	},

	/** Strip HTML tags (for REST API fields that contain markup) */
	stripTags(html) {
		return this.text(this.decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')));
	},

	/**
	 * Decode a response body using the charset of the Content-Type header,
	 * else of a <meta charset>, else UTF-8.
	 */
	decode(buffer, contentType) {
		let bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
		let charset = null;
		let m = /charset=["']?([\w-]+)/i.exec(contentType || '');
		if (m) charset = m[1];
		if (!charset) {
			let head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
			let mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head);
			if (mm) charset = mm[1];
		}
		let label = (charset || 'utf-8').toLowerCase();
		if (/^(latin-?1|iso[-_]?8859-1|us-ascii|ascii|l1|cp1252)$/.test(label)) label = 'windows-1252';
		try {
			let s = new TextDecoder(label).decode(bytes);
			// Node decodes windows-1252 as ISO-8859-1: map the C1 range to the right characters
			if (label === 'windows-1252') s = s.replace(/[\u0080-\u009f]/g, c => this._cp1252[c.charCodeAt(0) - 0x80] || c);
			return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
		}
		catch (e) {
			return new TextDecoder('utf-8').decode(bytes);
		}
	},

	_cp1252: '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ',

	/** XML text without declaration and without control characters invalid in XML (OJS 2 emits NULs) */
	cleanXml(text) {
		return String(text || '').replace(/^\s*<\?xml[^>]*>/, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
	},

	isPdfBytes(bytes) {
		if (!bytes) return false;
		let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		// %PDF may be preceded by a few bytes of garbage
		let n = Math.min(b.length - 4, 1024);
		for (let i = 0; i < n; i++) {
			if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true;
		}
		return false;
	},

	looksLikePdfUrl(u) {
		return /\.pdf($|[?#])/i.test(u || '') || /\/(download|pdf|galley|viewFile|bitstream)\b/i.test(u || '');
	},

	// ---- names ----

	_particles: /^(de|di|da|del|della|dello|dei|degli|delle|dal|dalla|van|von|der|den|la|le|lo|du|des|mac|mc|st\.?|san|el|al|ten|ter|y)$/i,

	/**
	 * Split a personal name into Zotero creator fields.
	 * Handles "Last, First", "First Last", "First LAST" (Italian style) and particles.
	 */
	parseName(raw, creatorType = 'author') {
		let s = this.text(raw)
			.replace(/^(prof\.?(ssa)?|dott\.?(ssa)?|avv\.?|dr\.?|on\.?|cons\.?|pres\.?|sen\.?|ing\.?)\s+/i, '')
			.replace(/\s*\*+$/, '')
			.replace(/\s*\(.*?\)\s*/g, ' ')
			.replace(/\d+$/, '')
			.trim();
		if (!s || !/\p{L}/u.test(s)) return null;
		if (s.includes(',')) {
			let [last, first] = s.split(/\s*,\s*/, 2);
			if (first) {
				return { firstName: this._fixCase(first), lastName: this._fixCase(last), creatorType };
			}
		}
		let parts = s.split(/\s+/);
		if (parts.length === 1) return { lastName: this._fixCase(s), firstName: '', fieldMode: 1, creatorType };
		// "Mario ROSSI" / "ROSSI Mario": an all-caps token marks the surname
		// (initials like "O." or "J.-P." are not surnames)
		let isCaps = w => w.length > 1 && w === w.toUpperCase() && /[A-ZÀ-Ý]{2}/.test(w.replace(/[.\-‐]/g, '')) && !/^([A-Z]\.[-‐]?)+$/.test(w);
		let capsIdx = parts.map((w, i) => isCaps(w) ? i : -1).filter(i => i >= 0);
		if (capsIdx.length && capsIdx.length < parts.length) {
			let last = capsIdx.map(i => parts[i]).join(' ');
			let first = parts.filter((w, i) => !capsIdx.includes(i)).join(' ');
			return { firstName: this._fixCase(first), lastName: this._fixCase(last), creatorType };
		}
		// particles belong to the surname: "Giulia Della Rocca", "Jan van Dijk"
		let i = parts.length - 1;
		while (i > 1 && this._particles.test(parts[i - 1])) i--;
		return {
			firstName: this._fixCase(parts.slice(0, i).join(' ')),
			lastName: this._fixCase(parts.slice(i).join(' ')),
			creatorType,
		};
	},

	_fixCase(s) {
		s = String(s || '').trim();
		if (s.length > 1 && s === s.toUpperCase() && /[A-ZÀ-Ý]{2}/.test(s)) {
			return s.toLowerCase().replace(/(^|[\s\-‐'’.])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
		}
		return s;
	},

	/** Split a free-text author list ("A. Rossi, B. Bianchi e C. Verdi") into creators */
	parseAuthors(str, creatorType = 'author') {
		let s = this.text(str);
		if (!s) return [];
		s = s.replace(/^(di|by|a cura di|edited by)\s+/i, '');
		let parts;
		// "Rossi, Mario; Bianchi, Anna" keeps the comma inside names
		if (s.includes(';')) parts = s.split(/\s*;\s*/);
		else parts = s.split(/\s*(?:,|\s+e\s+|\s+and\s+|\s+&\s+|\s+ed\s+|\s+et\s+|\s+y\s+|\s+und\s+)\s*/i);
		return parts.map(p => this.parseName(p, creatorType)).filter(Boolean);
	},

	// ---- dates ----

	_months: {
		gen: 1, gennaio: 1, jan: 1, january: 1, janvier: 1,
		feb: 2, febbraio: 2, february: 2, fevrier: 2, février: 2,
		mar: 3, marzo: 3, march: 3, mars: 3,
		apr: 4, aprile: 4, april: 4, avril: 4,
		mag: 5, maggio: 5, may: 5, mai: 5,
		giu: 6, giugno: 6, jun: 6, june: 6, juin: 6,
		lug: 7, luglio: 7, jul: 7, july: 7, juillet: 7,
		ago: 8, agosto: 8, aug: 8, august: 8, aout: 8, août: 8,
		set: 9, sett: 9, settembre: 9, sep: 9, sept: 9, september: 9, septembre: 9,
		ott: 10, ottobre: 10, oct: 10, october: 10, octobre: 10,
		nov: 11, novembre: 11, november: 11,
		dic: 12, dicembre: 12, dec: 12, december: 12, décembre: 12, decembre: 12,
	},

	/** Normalize a date to "YYYY-MM-DD", "YYYY-MM" or "YYYY" (or '' if none found) */
	parseDate(raw) {
		let s = this.text(raw).toLowerCase();
		if (!s) return '';
		let pad = n => String(n).padStart(2, '0');
		let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
		if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
		m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
		if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
		m = /(\d{1,2})\s*(?:°|º)?\s+([a-zà-ÿ]+)\.?,?\s+(\d{4})/.exec(s);
		if (m && this._months[m[2]]) return `${m[3]}-${pad(this._months[m[2]])}-${pad(m[1])}`;
		m = /([a-zà-ÿ]+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
		if (m && this._months[m[1]]) return `${m[3]}-${pad(this._months[m[1]])}-${pad(m[2])}`;
		m = /([a-zà-ÿ]+)\.?\s+(\d{4})/.exec(s);
		if (m && this._months[m[1]]) return `${m[2]}-${pad(this._months[m[1]])}`;
		m = /(\d{4})[-/](\d{1,2})\b/.exec(s);
		if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad(m[2])}`;
		m = /\b(1[89]\d\d|20\d\d)\b/.exec(s);
		return m ? m[1] : '';
	},

	yearOf(date) {
		let m = /\b(1[89]\d\d|20\d\d)\b/.exec(String(date || ''));
		return m ? +m[1] : null;
	},

	// ---- titles ----

	/** Title normalized for duplicate detection */
	normTitle(t) {
		return this.text(t).toLowerCase()
			.normalize('NFD').replace(/[̀-ͯ]/g, '')
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.trim();
	},

	cleanTitle(t) {
		let s = this.text(this.decodeEntities(String(t || '').replace(/<[^>]*>/g, '')));
		// quotes around the whole title only (not «Aree interne» e …)
		let q = /^["“«]\s*(.*?)\s*["”»]$/.exec(s);
		if (q && !/["“”«»]/.test(q[1])) s = q[1];
		// ALL CAPS titles are common in Italian journals' tables of contents
		if (s.length > 12 && s === s.toUpperCase() && /[A-Z]{4}/.test(s)) {
			s = s.charAt(0) + s.slice(1).toLowerCase();
		}
		return s;
	},

	// ---- embedded metadata ----

	/**
	 * Read Highwire (citation_*), Dublin Core and Open Graph metadata from a page.
	 * @returns {{meta: Object, pdfUrl: string|null}}
	 */
	parseEmbeddedMeta(doc, pageUrl) {
		let all = {};
		for (let el of doc.querySelectorAll('meta[name], meta[property]')) {
			let name = (el.getAttribute('name') || el.getAttribute('property') || '').trim();
			let content = el.getAttribute('content');
			if (!name || content == null) continue;
			// Digital Commons: bepress_citation_* duplicates citation_*
			let k = name.toLowerCase().replace(/^bepress_citation_/, 'citation_');
			(all[k] = all[k] || []).push(this.decodeEntities(content).trim());
		}
		let first = (...keys) => {
			for (let k of keys) if (all[k] && all[k][0]) return all[k][0];
			return '';
		};
		let meta = {};
		let title = first('citation_title', 'dc.title', 'eprints.title', 'og:title');
		if (title) meta.title = this.cleanTitle(title);
		let authors = all.citation_author || all['dc.creator'] || all['dc.contributor'] || all.author || [];
		// some sites put every author in one tag
		if (authors.length === 1 && /;|\s+e\s+|\s+and\s+/.test(authors[0])) {
			meta.creators = this.parseAuthors(authors[0]);
		}
		else {
			meta.creators = authors.map(a => this.parseName(a)).filter(Boolean);
		}
		let date = first('citation_publication_date', 'citation_date', 'citation_online_date', 'dc.date.issued', 'dc.date',
			'article:published_time', 'citation_cover_date');
		if (date) meta.date = this.parseDate(date);
		let set = (field, ...keys) => {
			let v = first(...keys);
			if (v) meta[field] = v;
		};
		set('publicationTitle', 'citation_journal_title', 'dc.source', 'dc.relation.ispartof');
		set('volume', 'citation_volume', 'dc.citation.volume');
		set('issue', 'citation_issue', 'dc.citation.issue');
		set('DOI', 'citation_doi', 'dc.identifier.doi', 'prism.doi');
		set('ISSN', 'citation_issn', 'prism.issn', 'prism.eissn');
		set('language', 'citation_language', 'dc.language');
		set('abstractNote', 'citation_abstract', 'dc.description', 'description', 'og:description');
		let fp = first('citation_firstpage'), lp = first('citation_lastpage');
		if (fp) meta.pages = lp && lp !== fp ? `${fp}-${lp}` : fp;
		if (!meta.DOI) {
			for (let id of all['dc.identifier'] || []) {
				let m = /(10\.\d{4,9}\/\S+)/.exec(id);
				if (m) {
					meta.DOI = m[1];
					break;
				}
			}
		}
		if (meta.DOI) meta.DOI = meta.DOI.replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '');
		let keywords = all.citation_keywords || all['dc.subject'] || [];
		if (keywords.length) meta.tags = keywords.flatMap(k => k.split(/\s*;\s*/)).filter(Boolean);
		// og:description/description are often site boilerplate: keep only real abstracts
		if (meta.abstractNote && !first('citation_abstract', 'dc.description') && meta.abstractNote.length < 120) {
			delete meta.abstractNote;
		}
		let pdfUrl = this.absUrl(first('citation_pdf_url', 'eprints.document_url'), pageUrl);
		let hasScholarly = !!(all.citation_title || all['dc.title'] || all.citation_pdf_url);
		return { meta, pdfUrl, hasScholarly };
	},

	/** Zotero fields from CSL-JSON (DOI content negotiation: Crossref, DataCite, mEDRA) */
	cslToMeta(csl) {
		let meta = {};
		if (!csl) return meta;
		if (csl.title) meta.title = this.cleanTitle(Array.isArray(csl.title) ? csl.title[0] : csl.title);
		meta.creators = (csl.author || []).map(a => (a.family
			? { firstName: a.given || '', lastName: a.family, creatorType: 'author' }
			: a.literal ? this.parseName(a.literal) : null)).filter(Boolean);
		let parts = csl.issued && csl.issued['date-parts'] && csl.issued['date-parts'][0];
		if (parts && parts[0]) meta.date = parts.map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join('-');
		let set = (field, v) => {
			if (v) meta[field] = String(Array.isArray(v) ? v[0] : v);
		};
		set('publicationTitle', csl['container-title']);
		set('volume', csl.volume);
		set('issue', csl.issue);
		set('pages', csl.page);
		set('DOI', csl.DOI);
		set('ISSN', csl.ISSN);
		set('language', csl.language);
		if (csl.abstract && csl.abstract.length > 120) meta.abstractNote = this.stripTags(csl.abstract);
		return meta;
	},

	/** Links in a document whose href (or text) looks like a PDF */
	pdfLinks(doc, base, root = doc) {
		let out = [];
		for (let a of root.querySelectorAll('a[href]')) {
			let href = this.absUrl(a.getAttribute('href'), base);
			if (!href) continue;
			if (/\.pdf($|[?#])/i.test(href) || /\bpdf\b/i.test(a.getAttribute('type') || '')) {
				out.push({ href, text: this.text(a), el: a });
			}
		}
		return out;
	},

	/** Merge metadata objects: later sources fill only fields still empty */
	mergeMeta(...sources) {
		let out = {};
		for (let src of sources) {
			if (!src) continue;
			for (let [k, v] of Object.entries(src)) {
				if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
				if (out[k] == null || out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) out[k] = v;
			}
		}
		return out;
	},

	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},
};

if (typeof module !== 'undefined') module.exports = { JCUtil };
