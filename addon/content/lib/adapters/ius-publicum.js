/* global JCAdapters, JCUtil */

/**
 * Ius Publicum (www.ius-publicum.it, WordPress without posts).
 *
 * Every issue is an accordion on the single page /fascicoli/: a header
 * "Fascicolo n. 2 - 2025-ISSN 2039 2540" followed by the list of PDF links, each written
 * "Author(s) - Title" (reports: "a. ENG: Author, Title"). The site shows a language
 * splash page unless ?goin=yes&lan=it is given. One request per run; issues other than
 * the newest are marked done.
 */
JCAdapters.register({
	id: 'ius-publicum',
	label: 'Ius Publicum',
	description: 'The /fascicoli/ page of ius-publicum.it: one accordion per issue with the article PDFs.',
	params: { start: 'issues page (default https://www.ius-publicum.it/fascicoli/?goin=yes&lan=it)' },

	async *discover(ctx) {
		let doc = await ctx.getDoc(ctx.params.start || 'https://www.ius-publicum.it/fascicoli/?goin=yes&lan=it');
		let heads = [...doc.querySelectorAll('.accordions-head')];
		ctx.log(`${heads.length} issues`);
		for (let [i, head] of heads.entries()) {
			if (ctx.cancelled) return;
			let label = JCUtil.text(head.getAttribute('main-text') || head.textContent).replace(/-?\s*ISSN.*$/i, '').trim();
			let m = /n\.\s*([\w/-]+?)\s*-\s*(\d{4})/i.exec(label);
			let year = m ? m[2] : JCUtil.yearOf(label);
			if (ctx.tooOld(String(year))) break;
			let issueKey = 'issue:' + label;
			if (await ctx.isIssueDone(issueKey)) continue;
			let content = head.nextElementSibling;
			if (!content) continue;
			let seen = new Set();
			for (let link of JCUtil.pdfLinks(doc, doc.__url, content)) {
				if (seen.has(link.href)) continue;
				seen.add(link.href);
				let block = link.el.closest('li, p') || link.el;
				// old issues put several links in one paragraph (separated by <br>): use the link text
				let same = [...block.querySelectorAll('a[href]')].filter(a => JCUtil.absUrl(a.getAttribute('href'), doc.__url) === link.href);
				let others = JCUtil.pdfLinks(doc, doc.__url, block).some(l => l.href !== link.href);
				let raw = others ? same.map(a => JCUtil.text(a)).join(' ') : JCUtil.text(block);
				let text = JCUtil.text(raw).replace(/^[a-z]\.\s*(?:[A-Z]{2,3}\s*:\s*)?/, '');
				if (/fascicolo completo|complete issue|^(indice|index)\b/i.test(text) || text.length < 8) continue;
				let title = text, creators = [];
				let s = /^(.{3,200}?)\s+[-–]\s+(.+)$/s.exec(text);
				if (s && !/[:?"“]/.test(s[1])) {
					creators = JCUtil.parseAuthors(s[1]);
					title = s[2];
				}
				yield {
					key: link.href,
					pdfUrl: link.href,
					meta: {
						title: JCUtil.cleanTitle(title),
						creators,
						date: String(year || ''),
						issue: m ? m[1] : '',
						publicationTitle: 'Ius Publicum',
						ISSN: '2039-2540',
					},
					issueKey,
					landing: false,
				};
			}
			if (i > 0) ctx.markIssueDone(issueKey);
		}
	},
});
