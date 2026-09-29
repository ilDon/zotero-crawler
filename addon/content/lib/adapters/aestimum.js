/* global JCAdapters, JCOai, JCOjs, JCUtil */

/**
 * Aestimum (Firenze University Press, OJS 3). Same OAI-PMH harvest as the generic "ojs"
 * adapter, with two fixes the generic adapter cannot do with params:
 *  - covers, indexes and editorial notices of the digitized back issues are in the same
 *    OAI sets as the articles: records whose title matches params.skipPattern are skipped;
 *  - the ~1600 digitized articles of 1977-2008 (dc:source without "Vol.") carry the digitization date (2009-06-01) in
 *    dc:date: the year in dc:source ("Aestimum; Seminari 13 (1992)") is used instead, and
 *    the dc:source label becomes the issue when it has no "Vol."/"No.".
 */
JCAdapters.register({
	id: 'aestimum',
	label: 'Aestimum (OJS)',
	description: 'OJS OAI-PMH harvest with a title filter and the publication year taken from dc:source.',
	params: {
		base: 'journal URL',
		excludeSets: 'OAI sets to skip',
		skipPattern: 'regex (case-insensitive): skip records whose title matches',
	},

	async *discover(ctx) {
		let p = ctx.params;
		let base = p.base.replace(/\/+$/, '');
		let skip = p.skipPattern ? new RegExp(p.skipPattern, 'i') : null;
		let exclude = (p.excludeSets || []).map(s => s.toLowerCase());
		// a record cannot have been modified before it was published
		let from = ctx.state.oaiFrom || (ctx.since ? `${ctx.since}-01-01` : null);
		let n = 0;
		for await (let rec of JCAdapters.oaiRecords(ctx, { endpoint: base + '/oai', from })) {
			if (rec.header.deleted || !rec.metadata) continue;
			if (rec.header.sets.some(s => exclude.some(e => s.toLowerCase().endsWith(':' + e)))) continue;
			let ref = JCOai.recordToRef(rec, {
				landingPattern: '/article/view/\\d+/?$',
				pdfPattern: '/article/(download|viewFile)/\\d+/\\d+',
				relationToPdf: u => JCOjs.galleyToDownload(u),
			});
			let m = ref.meta;
			if (!m.title || (skip && skip.test(m.title))) continue;
			let source = (JCAdapters.dublinCore(rec.metadata).source || [])[0];
			let sm = source && /;\s*([^;]*?)\s*\((\d{4})\)/.exec(source.text);
			if (sm && !m.volume && (!m.date || +sm[2] < JCUtil.yearOf(m.date))) {
				m.date = sm[2];
				if (!m.issue && sm[1]) m.issue = sm[1].replace(/^Aestimum\s+/i, '');
			}
			// empty OAI creators (" , ") become a bogus "," author
			m.creators = (m.creators || []).filter(c => /\p{L}/u.test(`${c.lastName || ''}${c.firstName || ''}`));
			if (ctx.tooOld(m.date)) continue;
			n++;
			yield ref;
		}
		if (!ctx.cancelled && ctx._oaiResponseDate) {
			let d = new Date(ctx._oaiResponseDate);
			if (!isNaN(d)) {
				d.setUTCDate(d.getUTCDate() - 1);
				ctx.state.oaiFrom = d.toISOString().slice(0, 10);
			}
		}
		ctx.log(`Aestimum OAI-PMH: ${n} records${from ? ' changed since ' + from : ''}`);
	},
});
