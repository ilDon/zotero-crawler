/* global JCAdapters, JCUtil, JCWordPress */

/**
 * Network Industries Quarterly (www.network-industries.org, WordPress + Divi).
 *
 * Every NIQ issue is a WordPress post (year categories; the category "publications" holds
 * book notices and is excluded). The Divi layout is not rendered in the REST content, so
 * each issue post page is read: from 2015 to mid-2023 it lists every article as a Divi
 * "blurb" (h4 title linking the article PDF, authors below); other issues only have the
 * full-issue PDF ("Read now"), which is then imported as one item. Volume and issue come
 * from the full-issue PDF file name (NIQ-Vol-27-Issue-1-April-2026.pdf).
 */
JCAdapters.register({
	id: 'network-industries-quarterly',
	label: 'Network Industries Quarterly',
	description: 'NIQ issue posts of network-industries.org (REST list, then the post page): article PDFs, or the full issue when not split.',
	params: { base: 'site URL', query: 'REST filter (default {"categories_exclude":"12"})' },

	async *discover(ctx) {
		let p = Object.assign({ base: 'https://www.network-industries.org', query: { categories_exclude: '12' } }, ctx.params);
		p.fieldsList = 'id,date,link,title';
		let state = ctx.state;
		let after = null;
		if (state.complete && state.lastDate) {
			let d = new Date(state.lastDate);
			d.setUTCDate(d.getUTCDate() - 120);
			after = d.toISOString().slice(0, 19);
		}
		else if (ctx.since) {
			after = `${ctx.since - 1}-12-31T23:59:59`;
		}
		let newest = null;
		for await (let post of JCWordPress.posts(ctx, p, { query: p.query, after })) {
			if (ctx.cancelled) return;
			let isNewest = !newest;
			if (!newest) newest = post.date;
			if (ctx.tooOld(post.date)) break;
			let issueKey = 'post:' + post.id;
			if (await ctx.isIssueDone(issueKey)) continue;
			let doc = await ctx.getDoc(post.link);
			let theme = JCUtil.cleanTitle(JCUtil.stripTags(post.title && post.title.rendered));
			let full = [...doc.querySelectorAll('a[href$=".pdf"]')].find(a => /\.et_pb_button|et_pb_button/.test(a.getAttribute('class') || '') || /read now/i.test(JCUtil.text(a)));
			let fullUrl = full && JCUtil.absUrl(full.getAttribute('href'), doc.__url);
			let vm = /vol[._-]*(\d+)[._-]*(?:issue|no)[._-]*(\d+)/i.exec(fullUrl || '');
			let base = {
				date: (post.date || '').slice(0, 10),
				volume: vm ? vm[1] : '',
				issue: vm ? vm[2] : '',
				publicationTitle: 'Network Industries Quarterly',
			};
			let refs = [];
			for (let blurb of doc.querySelectorAll('.et_pb_blurb')) {
				let a = blurb.querySelector('.et_pb_module_header a[href$=".pdf"]') || blurb.querySelector('a[href$=".pdf"]');
				let title = JCUtil.text(blurb.querySelector('.et_pb_module_header'));
				let href = a && JCUtil.absUrl(a.getAttribute('href'), doc.__url);
				if (!href || !title || /^(announcements?|editorial board|contents?)$/i.test(title)) continue;
				let by = JCUtil.text(blurb.querySelector('.et_pb_blurb_description'));
				refs.push({
					key: href,
					pdfUrl: href,
					meta: Object.assign({ title: JCUtil.cleanTitle(title), creators: by && by.length < 200 ? JCUtil.parseAuthors(by) : [] }, base),
					issueKey,
					landing: false,
				});
			}
			if (!refs.length && fullUrl) {
				refs.push({
					key: fullUrl,
					url: post.link,
					pdfUrl: fullUrl,
					meta: Object.assign({ title: theme, creators: [], extra: 'Full issue' }, base),
					issueKey,
					landing: false,
				});
			}
			for (let ref of refs) yield ref;
			if (!isNewest) ctx.markIssueDone(issueKey);
		}
		if (!ctx.cancelled) {
			state.complete = true;
			if (newest && (!state.lastDate || newest > state.lastDate)) state.lastDate = newest;
		}
	},
});
