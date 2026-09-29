/* global JCAdapters, JCUtil */

/**
 * Istituzioni del Federalismo (Regione Emilia-Romagna, Plone 6 / Volto).
 *
 * The HTML pages are rendered by JavaScript, so the Plone REST API (/++api++/…) is used:
 * /idf/numeri → year folders → issue folders → items. Up to 2024 every article is a PDF
 * (File item, title "Titolo / Autori", file name "firstpage_lastpage.pdf"); from 2025 articles
 * are web pages (Document items) without their own PDF: their web page is converted to PDF.
 * Full-issue PDFs and indexes are skipped. Issues done in earlier runs are skipped; a year is
 * not even listed again once all its issues are done.
 */
JCAdapters.register({
	id: 'istituzioni-del-federalismo',
	label: 'Istituzioni del Federalismo (Plone REST API)',
	description: 'Year and issue folders of regione.emilia-romagna.it/idf through the Plone REST API; PDF per article up to 2024, web pages from 2025.',
	params: {
		base: 'site root (default https://www.regione.emilia-romagna.it)',
		path: 'path of the issues folder (default /idf/numeri)',
	},

	async *discover(ctx) {
		let root = (ctx.params.base || 'https://www.regione.emilia-romagna.it').replace(/\/+$/, '');
		let path = ctx.params.path || '/idf/numeri';
		let api = u => u.replace(root, root + '/++api++') + '?b_size=500';
		let get = u => ctx.getJSON(api(u), { headers: { Accept: 'application/json' } });
		let skip = /numero completo|^indice\b|^sommario\b|^copertina|^frontespizio/i;

		let years = (await get(root + path)).items
			.filter(i => /\/\d{4}$/.test(i['@id']))
			.sort((a, b) => b['@id'].localeCompare(a['@id']));
		let first = true;
		for (let year of years) {
			if (ctx.cancelled) return;
			let y = +year['@id'].slice(-4);
			if (ctx.since && y < ctx.since) break;
			let yearKey = 'year:' + y;
			let newestYear = first;
			first = false;
			if (await ctx.isIssueDone(yearKey)) continue;
			// newest issue first: "4_2025" > "3-2025" > …; "quaderno-…" after the issues
			let num = i => {
				let id = i['@id'].split('/').pop();
				let m = /^(\d+)/.exec(id);
				return m ? +m[1] : -1;
			};
			let issues = (await get(year['@id'])).items.filter(i => i['@type'] === 'Document').sort((a, b) => num(b) - num(a));
			let allDone = true;
			for (let [n, iss] of issues.entries()) {
				if (ctx.cancelled) return;
				let issueKey = iss['@id'];
				if (await ctx.isIssueDone(issueKey)) continue;
				allDone = false;
				let id = issueKey.split('/').pop();
				let label = id.replace(/[_-]\d{4}$/, '').replace(/^quaderno-(\d+).*/, 'Quaderno $1');
				let detail = await get(issueKey);
				for (let item of detail.items || []) {
					let title = JCUtil.text(item.title);
					let file = item['@id'].split('/').pop();
					if (!title || skip.test(title) || /^(idfe_|numero-completo|indice)/i.test(file)) continue;
					// the full issue carries the issue's own title
					if (JCUtil.normTitle(title) === JCUtil.normTitle(iss.title)) continue;
					if (!['File', 'Document'].includes(item['@type'])) continue;
					// "Titolo / Autore, Autore"
					let authors = '';
					let m = /^(.*\S)\s+\/\s+([^/]+)$/.exec(title);
					if (m) [title, authors] = [m[1], m[2]];
					let meta = {
						title: JCUtil.cleanTitle(title),
						creators: JCUtil.parseAuthors(authors),
						date: String(y),
						issue: label,
					};
					let vol = /anno\s+([IVXLC]+)\b/i.exec(item.description || iss.description || '');
					if (vol) meta.volume = vol[1];
					if (item['@type'] === 'File') {
						let pp = /^(\d+)_(\d+)(?:-\d+)?\.pdf$/i.exec(file);
						if (pp) meta.pages = `${pp[1]}-${pp[2]}`;
						yield { key: item['@id'], pdfUrl: item['@id'] + '/@@download/file', meta, issueKey, landing: false };
					}
					else {
						yield { key: item['@id'], url: item['@id'], meta, issueKey, landing: false, htmlToPdf: true };
					}
				}
				// the newest issue may still grow
				if (!(newestYear && n === 0)) ctx.markIssueDone(issueKey);
			}
			if (allDone && !newestYear) ctx.markIssueDone(yearKey);
		}
	},
});
