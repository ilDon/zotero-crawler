/* global JCAdapters, JCUtil */

/**
 * WordPress sites, through the REST API (/wp-json/wp/v2/…), newest first.
 *
 * Two layouts are common among journals:
 *  - one post per article (default): title, date and link come from the post, the PDF
 *    from a link in its content (or from its PDF attachments), authors from a selector,
 *    from a title pattern, or from the landing page;
 *  - one post per issue (perIssue: true): every PDF linked in the content is an article,
 *    described by the text around the link (itemSelector).
 *
 * Incremental: after a complete crawl only posts published after the last one seen
 * (minus a margin) are requested.
 */
var JCWordPress = {
	/** Base URL of the REST API: <base>/wp-json or ?rest_route= */
	api(p, route, query = {}) {
		let base = p.base.replace(/\/+$/, '');
		let q = new URLSearchParams(query);
		if (p.restRoute) {
			q.set('rest_route', '/wp/v2/' + route);
			return `${base}/?${q}`;
		}
		return `${base}/wp-json/wp/v2/${route}?${q}`;
	},

	/**
	 * Iterate posts of a type, newest first. Yields raw post objects.
	 * opts: {type, query, after (ISO date)}
	 */
	async *posts(ctx, p, { type = 'posts', query = {}, after = null } = {}) {
		let perPage = p.perPage || 50;
		for (let page = 1; !ctx.cancelled; page++) {
			let q = { per_page: perPage, page, orderby: 'date', order: 'desc', ...query };
			if (after) q.after = after;
			if (p.fields !== false) {
				q._fields = p.fieldsList || 'id,date,modified,link,title,content,excerpt,categories,tags,coauthors,authors,acf,meta,yoast_head_json,type,parent';
			}
			let res = await ctx.request(this.api(p, type, q), { allowErrors: true, headers: { Accept: 'application/json' } });
			if (res.status === 400 && page > 1) return; // past the last page
			if (res.status >= 400) throw new Error(`HTTP ${res.status} ${res.url}`);
			let list;
			try {
				// some sites inject markup (<style>…) before the JSON
				let text = res.text;
				let start = text.search(/[[{]/);
				list = JSON.parse(start > 0 ? text.slice(start) : text);
			}
			catch (e) {
				throw new Error(`Invalid JSON from ${res.url}`);
			}
			if (!Array.isArray(list) || !list.length) return;
			for (let post of list) yield post;
			let totalPages = +(res.headers.get('x-wp-totalpages') || 0);
			if (totalPages && page >= totalPages) return;
			if (list.length < perPage) return;
		}
	},

	/** Author names of a post from co-authors plugins, yoast data or a content selector */
	authorsOf(post, contentDoc, p) {
		let names = [];
		let from = p.authorsFrom || 'auto';
		if (from === 'coauthors' || from === 'auto') {
			for (let c of post.coauthors || post.authors || []) {
				let n = c.display_name || c.name || (typeof c === 'string' ? c : '');
				if (n) names.push(n);
			}
		}
		if (!names.length && from === 'yoast' && post.yoast_head_json) {
			let a = post.yoast_head_json.author || (post.yoast_head_json.twitter_misc || {})['Written by'] || (post.yoast_head_json.twitter_misc || {})['Scritto da'];
			if (a) names.push(a);
		}
		if (!names.length && p.authorSelector && contentDoc) {
			let els = contentDoc.querySelectorAll(p.authorSelector);
			if (els.length === 1) return JCUtil.parseAuthors(JCUtil.text(els[0]));
			for (let el of els) names.push(JCUtil.text(el));
		}
		return names.flatMap(n => JCUtil.parseAuthors(n));
	},

	/** Apply params.titlePattern (regex with named groups title/authors) to a string */
	splitTitle(s, p) {
		if (!p.titlePattern) return { title: s };
		let m = new RegExp(p.titlePattern, 'su').exec(s);
		if (!m || !m.groups) return { title: s };
		return {
			title: m.groups.title ? JCUtil.text(m.groups.title) : s,
			authors: m.groups.authors ? JCUtil.parseAuthors(m.groups.authors) : null,
		};
	},

	parseContent(ctx, html, base) {
		let doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html || ''}</body></html>`, 'text/html');
		doc.__url = base;
		return doc;
	},

	/** refs for one post in the one-post-per-article layout */
	articleRef(ctx, post, p) {
		let rawTitle = JCUtil.stripTags(post.title && post.title.rendered);
		let content = this.parseContent(ctx, post.content && post.content.rendered, post.link);
		let { title, authors } = this.splitTitle(rawTitle, p);
		let root = p.contentSelector ? content.querySelector(p.contentSelector) || content : content;
		let pdfs = p.pdfFromContent === false ? [] : p.pdfSelector
			? [...root.querySelectorAll(p.pdfSelector)].map(a => JCUtil.absUrl(a.getAttribute('href'), post.link)).filter(Boolean)
			: JCUtil.pdfLinks(content, post.link, root).map(l => l.href);
		if (p.acfPdfField && post.acf && post.acf[p.acfPdfField]) {
			let v = post.acf[p.acfPdfField];
			pdfs.unshift(typeof v === 'string' ? v : v.url);
		}
		let meta = {
			title: JCUtil.cleanTitle(title),
			creators: authors || this.authorsOf(post, content, p),
			date: (post.date || '').slice(0, 10),
		};
		if (p.abstractSelector) {
			let a = root.querySelector(p.abstractSelector);
			if (a) meta.abstractNote = JCUtil.text(a);
		}
		return {
			key: post.link,
			url: post.link,
			pdfUrls: [...new Set(pdfs)],
			meta,
			wpId: post.id,
			// without landing: the post page is still read when the content has no PDF link
			landing: p.landing ? true : undefined,
			preferAdapterMeta: !p.landing,
		};
	},

	/** refs for one post in the one-post-per-issue layout */
	issueRefs(ctx, post, p) {
		let content = this.parseContent(ctx, post.content && post.content.rendered, post.link);
		let refs = [];
		let seen = new Set();
		let issueTitle = JCUtil.stripTags(post.title && post.title.rendered);
		for (let link of JCUtil.pdfLinks(content, post.link)) {
			if (seen.has(link.href)) continue;
			seen.add(link.href);
			let item = p.itemSelector ? link.el.closest(p.itemSelector) : link.el.parentElement;
			let text = JCUtil.text(item || link.el);
			let title = text, creators = [];
			if (p.titleSelector && item) {
				let t = item.querySelector(p.titleSelector);
				if (t) title = JCUtil.text(t);
			}
			if (p.authorSelector && item) {
				let a = item.querySelector(p.authorSelector);
				if (a) creators = JCUtil.parseAuthors(JCUtil.text(a));
			}
			if (p.titlePattern) {
				let s = this.splitTitle(text, p);
				title = s.title;
				if (s.authors) creators = s.authors;
			}
			if (!title || title.length < 5) continue;
			refs.push({
				key: link.href,
				pdfUrl: link.href,
				meta: { title: JCUtil.cleanTitle(title), creators, date: (post.date || '').slice(0, 10), issue: issueTitle },
				issueKey: 'post:' + post.id,
				landing: false,
			});
		}
		return refs;
	},
};

JCAdapters.register({
	id: 'wordpress',
	label: 'WordPress (REST API)',
	description: 'WordPress sites through /wp-json. One post per article (default) or per issue (perIssue).',
	params: {
		base: 'site URL, e.g. https://www.example-journal.it',
		type: 'REST route of the post type (default "posts"; custom types like "articoli")',
		query: 'extra query parameters, e.g. {"categories": "12,15"}',
		perIssue: 'true if every post is an issue that links several article PDFs',
		itemSelector: 'perIssue: element around each PDF link that describes the article (default: parent)',
		titlePattern: 'regex with named groups (?<authors>…) and (?<title>…) applied to the post title / item text',
		authorsFrom: '"auto" (co-authors plugin), "yoast", or use authorSelector',
		authorSelector: 'CSS selector for authors in the post content',
		pdfSelector: 'CSS selector for the PDF link in the post content (default: links ending in .pdf)',
		pdfFromContent: 'false: ignore PDF links in the content (they are cited documents); use the post page instead',
		contentSelector: 'CSS selector restricting where to look in the content',
		landing: 'true: read citation_* metadata from the post page',
		landingPdfSelector: 'CSS selector of the PDF link on the post page, when the content has none',
		requirePdf: 'false: also take posts without a PDF link in the content (PDF from the post page, or htmlToPdf)',
		skipPattern: 'regex: skip posts whose title matches',
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.base) throw new Error('params.base missing');
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
		let newest = null;
		let inc = ctx.incremental(p.stopAfterSeen || 30);
		for await (let post of JCWordPress.posts(ctx, p, { type: p.type || 'posts', query: p.query || {}, after })) {
			if (!newest) newest = post.date;
			if (ctx.tooOld(post.date)) break;
			if (p.perIssue) {
				let issueKey = 'post:' + post.id;
				if (await ctx.isIssueDone(issueKey)) continue;
				for (let ref of JCWordPress.issueRefs(ctx, post, p)) yield ref;
				if (newest !== post.date) ctx.markIssueDone(issueKey);
				continue;
			}
			if (await inc.seen(post.link)) {
				if (inc.stop) break;
				continue;
			}
			let ref = JCWordPress.articleRef(ctx, post, p);
			if (p.skipPattern && new RegExp(p.skipPattern, 'i').test(ref.meta.title)) continue;
			if (!ref.pdfUrls.length && p.requirePdf !== false && !p.landing && !p.landingPdfSelector) continue;
			yield ref;
		}
		if (!ctx.cancelled) {
			inc.complete();
			if (newest && (!state.lastDate || newest > state.lastDate)) state.lastDate = newest;
		}
	},
});
