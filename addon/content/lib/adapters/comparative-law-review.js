/* global JCAdapters, JCOai */

/**
 * Comparative Law Review (Nicolaus Copernicus University, Toruń; OJS 3). The generic OJS
 * OAI-PMH harvest, with two differences the "ojs" adapter cannot do with params:
 *  - the 2013-2020 articles have a textual URL path (…/article/view/CLR.2013.001/2053), which
 *    the generic patterns (numeric ids only) do not recognize as landing page / galley;
 *  - the yearly "Title page and table of contents" and an erratum are in the same OAI sets as
 *    the articles: records whose title matches params.skipPattern are skipped.
 */
JCAdapters.register({
	id: 'comparative-law-review',
	label: 'Comparative Law Review (OJS)',
	description: 'OJS OAI-PMH harvest accepting textual article paths; titles matching params.skipPattern are skipped.',
	params: {
		base: 'journal URL',
		excludeSets: 'OAI sets to skip',
		skipPattern: 'regex (case-insensitive): skip records whose title matches',
	},

	async *discover(ctx) {
		let p = ctx.params;
		let base = p.base.replace(/\/+$/, '');
		let skip = p.skipPattern ? new RegExp(p.skipPattern, 'i') : null;
		let refs = JCOai.harvest(ctx, {
			endpoint: base + '/oai',
			excludeSets: p.excludeSets,
			landingPattern: '/article/view/[^/]+/?$',
			pdfPattern: '/article/(download|viewFile)/[^/]+/\\d+',
			// galley page …/article/view/<id or path>/<galley> → …/article/download/<id or path>/<galley>
			relationToPdf: u => {
				let m = /^(.*\/article\/)(?:view|viewFile|download)\/([^/]+)\/(\d+)\/?$/.exec(u || '');
				return m ? `${m[1]}download/${m[2]}/${m[3]}` : null;
			},
		});
		for await (let ref of refs) {
			if (skip && skip.test(ref.meta.title || '')) continue;
			yield ref;
		}
	},
});
