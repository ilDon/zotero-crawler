/* global JCAdapters, JCUtil, JCWordPress */

/**
 * Rivista quadrimestrale di diritto dell'ambiente (rqda.eu), WordPress.
 *
 * One post per article ("AUTORE – Titolo"), PDF behind a WP Download Manager link (?dl_id=N),
 * issue given by the post's category ("Rivista numero 2 2025", or a section child of it).
 * This is the generic wordpress adapter plus what params cannot express: skipping the posts
 * that carry the whole issue or its index ("Anno 2025 – RIVISTA NUMERO 2", "Indice Rivista …",
 * "Numero Speciale S1/2026"), news and the English duplicates, and taking year/issue from the
 * category instead of the (later) publication date of the post.
 */
JCAdapters.register({
	id: 'quadrimestrale-diritto-dellambiente',
	label: 'Rivista quadrimestrale di diritto dell\'ambiente (rqda.eu)',
	description: 'WordPress posts (one per article) with year/issue from the issue category; full issues, indexes and news skipped.',
	params: {},

	async *discover(ctx) {
		let p = {
			base: 'https://www.rqda.eu',
			pdfSelector: 'a[href*="dl_id="]',
			// "NOME COGNOME – Titolo", "NOME COGNOME, Titolo", "NOME COGNOME Titolo"
			titlePattern: '^(?<authors>\\p{Lu}[\\p{Lu}\\s.,’\'\\-]+)(?:\\s+[–-]\\s+|,\\s+|\\s+(?=\\p{Lu}\\p{Ll}))(?<title>.+)$',
			...ctx.params,
		};
		let skip = /^(anno \d{4}\s*[–-]|indice\b|index\b|numero speciale s\d)/i;

		// issue categories: "Rivista numero 2 2025" (sections are children of them)
		let cats = new Map();
		for (let page = 1; page < 5; page++) {
			let list = await ctx.getJSON(JCWordPress.api(p, 'categories', { per_page: 100, page, _fields: 'id,name,slug,parent' }));
			for (let c of list) cats.set(c.id, c);
			if (list.length < 100) break;
		}
		let issueOf = (post) => {
			for (let id of post.categories || []) {
				let c = cats.get(id);
				if (c && c.parent && cats.get(c.parent)) c = cats.get(c.parent);
				let name = c ? JCUtil.decodeEntities(c.name) : '';
				if (c && /-en[-\d]*$|-eng$/.test(c.slug)) return { english: true };
				let m = /numero\s+speciale\s+(S\d+)\s*(\d{4})/i.exec(name)
					|| /numero\s+(\d+(?:-\d)?)[\s-]+(\d{4})\b/i.exec(name)
					|| /numero\s+(\d+)\b()/i.exec(name);
				if (m) return { issue: m[1], year: m[2] || '' };
			}
			return null;
		};

		let state = ctx.state;
		let after = null;
		if (state.complete && state.lastDate) {
			let d = new Date(state.lastDate);
			d.setUTCDate(d.getUTCDate() - 60);
			after = d.toISOString().slice(0, 19);
		}
		let newest = null;
		let inc = ctx.incremental(30);
		for await (let post of JCWordPress.posts(ctx, p, { after })) {
			if (!newest) newest = post.date;
			let info = issueOf(post);
			if (!info || info.english) continue; // news, uncategorized, English duplicates
			let year = info.year || (post.date || '').slice(0, 4);
			if (ctx.tooOld(post.date) && ctx.tooOld(year)) break;
			if (ctx.tooOld(year)) continue;
			let raw = JCUtil.stripTags(post.title && post.title.rendered);
			if (skip.test(raw)) continue;
			if (await inc.seen(post.link)) {
				if (inc.stop) break;
				continue;
			}
			let ref = JCWordPress.articleRef(ctx, post, p);
			if (!ref.pdfUrls.length) continue;
			ref.meta.date = year;
			ref.meta.issue = info.issue;
			yield ref;
		}
		if (!ctx.cancelled) {
			inc.complete();
			if (newest && (!state.lastDate || newest > state.lastDate)) state.lastDate = newest;
		}
	},
});
