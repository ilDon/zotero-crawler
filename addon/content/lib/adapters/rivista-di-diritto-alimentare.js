/* global JCAdapters, JCUtil */

/**
 * Rivista di diritto alimentare (rivistadirittoalimentare.it).
 *
 * The home page has a <select id="rda-el-issue"> listing every issue slug ("2026-02",
 * "2026-02 Quad.", "2025-0Indici", …) newest first; a script then loads
 * /rivista/<slug>/sommario.txt, a plain-text table of contents:
 *   T#<section>
 *   A#<title>#<authors>#<file.pdf>
 * and every PDF is /rivista/<slug>/<file.pdf>. The yearly index issues ("…Indici") are skipped.
 */
var JCRda = {
	base: 'https://www.rivistadirittoalimentare.it',

	/** UTF-8 when valid, else ISO-8859-1 (older files) */
	decode(bytes) {
		let s;
		try {
			s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		}
		catch (e) {
			s = new TextDecoder('iso-8859-1').decode(bytes);
		}
		return s.replace(/^﻿/, '');
	},

	/** "qualita'" → "qualità" (ASCII accents), keeping quoted 'phrases' intact */
	accents(s) {
		let map = { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' };
		let out = '';
		let open = false;
		for (let i = 0; i < s.length; i++) {
			let c = s[i];
			if (c === "'") {
				let prev = s[i - 1] || ' ', next = s[i + 1] || ' ';
				if (/[\s(«"]/.test(prev) && /\p{L}/u.test(next)) {
					open = true;
				}
				else if (/\p{L}/u.test(prev) && !/\p{L}/u.test(next)) {
					if (open) open = false;
					else if (map[prev]) {
						out = out.slice(0, -1) + map[prev];
						continue;
					}
				}
			}
			out += c;
		}
		return out;
	},
};

JCAdapters.register({
	id: 'rivista-di-diritto-alimentare',
	label: 'Rivista di diritto alimentare',
	description: 'Issue list from the home page selector, tables of contents from /rivista/<issue>/sommario.txt.',
	params: {},

	async *discover(ctx) {
		let home = await ctx.getDoc(JCRda.base + '/');
		let slugs = [...home.querySelectorAll('#rda-el-issue option')]
			.map(o => (o.getAttribute('value') || '').trim())
			.filter(v => v && !/indic/i.test(v));
		// the latest issue (and its Quaderno) may still grow: never mark it done
		let newest = (/^\d{4}-\d+/.exec(slugs[0] || '') || [''])[0];
		for (let slug of slugs) {
			if (ctx.cancelled) return;
			let m = /^(\d{4})-(\d+)/.exec(slug);
			if (!m) continue;
			let year = m[1];
			let isNewest = m[0] === newest;
			if (ctx.tooOld(year)) break;
			let key = 'rda:' + slug;
			if (await ctx.isIssueDone(key)) continue;
			let dir = `${JCRda.base}/rivista/${encodeURIComponent(slug)}/`;
			let res = await ctx.request(dir + 'sommario.txt', { allowErrors: true });
			if (res.status >= 400) {
				ctx.warn(`${slug}: sommario.txt HTTP ${res.status}`);
				continue;
			}
			let issue = String(+m[2]) + (/quad/i.test(slug) ? ' (Quaderno)' : '');
			let section = '';
			for (let line of JCRda.decode(res.bytes).split(/\r?\n/)) {
				line = line.trim();
				if (line.startsWith('T#')) {
					section = line.slice(2).trim();
					continue;
				}
				if (!line.startsWith('A#')) continue;
				let [title, authors, file] = line.slice(2).split('#').map(x => (x || '').trim());
				if (!title || !file || !/\.pdf$/i.test(file)) continue;
				let pdfUrl = dir + encodeURIComponent(file);
				let meta = {
					title: JCUtil.cleanTitle(JCRda.accents(title)),
					creators: /^(aida|(la )?redazione)/i.test(authors) ? [] : JCUtil.parseAuthors(JCRda.accents(authors)),
					date: year,
					issue,
				};
				if (section) meta.extra = 'Sezione: ' + JCRda.accents(section);
				yield { key: pdfUrl, pdfUrl, url: null, meta, issueKey: key };
			}
			if (!isNewest) ctx.markIssueDone(key);
		}
	},
});
