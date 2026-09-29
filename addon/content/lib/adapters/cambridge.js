/* global JCAdapters, JCCrossref */

/**
 * Cambridge Core journals (Cambridge University Press).
 *
 * The article list comes from Crossref (see crossref.js): every DOI of the journal, newest
 * first, incremental by deposit date, with the license of each article, so hybrid journals
 * can be limited to open-access articles (Creative Commons license; default oaOnly: true).
 * Metadata come from Crossref; the PDF from citation_pdf_url of the Cambridge Core article
 * page (open-access PDFs are served without login). FirstView articles are imported when
 * they first appear, so they may lack volume/issue.
 */
JCAdapters.register({
	id: 'cambridge',
	label: 'Cambridge Core',
	description: 'Cambridge Core journals: article list from Crossref (open-access articles only by default), PDF from the article page.',
	params: {
		issn: 'ISSN of the journal (print or online)',
		oaOnly: 'false to also import articles without a Creative Commons license (default true)',
		skipPattern: 'regex: skip articles whose title matches (default: cover/front/back matter, errata)',
		keywords: 'regex: keep only articles whose title/abstract match',
	},

	async *discover(ctx) {
		let p = ctx.params;
		if (!p.issn) throw new Error('params.issn missing');
		yield* JCCrossref.refs(ctx, {
			...p,
			oaOnly: p.oaOnly !== false,
			landing: true,
			transform(ref) {
				// the DOI resolves to the article page, which carries citation_pdf_url
				ref.pdfUrls = [];
				return ref;
			},
		});
	},
});
