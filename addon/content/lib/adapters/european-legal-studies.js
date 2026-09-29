/* global JCAdapters, JCUtil, JCOai */

/**
 * European Journal of Legal Studies (EUI). The journal site (sites.eui.eu, Contensis) links
 * every article to the EUI repository Cadmus (DSpace 7, JavaScript-only pages), which has
 * the whole journal in one collection and an OAI-PMH endpoint: metadata come from oai_dc
 * (incremental by datestamp), the PDF from the item's ORE record (ORIGINAL bitstream,
 * downloaded through the REST API /server/api/core/bitstreams/<uuid>/content).
 */
JCAdapters.register({
	id: 'european-legal-studies',
	label: 'European Journal of Legal Studies (Cadmus OAI-PMH)',
	description: 'OAI-PMH harvest of the EJLS collection in Cadmus (EUI); PDF from the ORE record.',
	params: {
		endpoint: 'OAI-PMH endpoint (default https://cadmus.eui.eu/server/oai/request)',
		set: 'collection set (default col_1814_6775)',
	},

	async *discover(ctx) {
		let p = ctx.params;
		let endpoint = p.endpoint || 'https://cadmus.eui.eu/server/oai/request';
		let set = p.set || 'col_1814_6775';
		let state = ctx.state;
		let from = state.oaiFrom || (ctx.since ? `${ctx.since}-01-01` : null);
		for await (let rec of JCAdapters.oaiRecords(ctx, { endpoint, set, from })) {
			if (rec.header.deleted || !rec.metadata) continue;
			let ref = JCOai.recordToRef(rec, { landingPattern: 'hdl\\.handle\\.net', pdfPattern: '^$' });
			let dc = JCAdapters.dublinCore(rec.metadata);
			let m = ref.meta;
			if (!m.title) continue;
			m.title = m.title.replace(/\s+:\s+/g, ': ');
			// "European journal of legal studies, 2026, Vol. 18, No. 1, pp. 20-57"
			let cit = (dc.identifier || []).map(v => v.text).find(t => /legal studies,/i.test(t)) || '';
			let c = /,\s*(\d{4})\s*,\s*Vol\.\s*(\w+)\s*,\s*(?:No\.\s*)?([\w./-]+)?(?:\s*,\s*pp\.\s*([\d]+\s*-\s*[\d]+))?/i.exec(cit);
			if (c) {
				m.volume = c[2];
				if (c[3]) m.issue = c[3];
				if (c[4]) m.pages = c[4].replace(/\s+/g, '');
			}
			let descs = (dc.description || []).map(v => v.text);
			let online = descs.map(d => /^Published online:\s*(.+)$/i.exec(d)).find(Boolean);
			let issued = (dc.date || []).map(v => v.text).find(d => /^\d{4}(-\d\d)?(-\d\d)?$/.test(d));
			m.date = online ? JCUtil.parseDate(online[1]) : (issued || (c && c[1]) || m.date);
			m.abstractNote = descs.filter(d => !/^(Published online|Special Issue)/i.test(d)).sort((a, b) => b.length - a.length)[0] || '';
			m.publicationTitle = 'European Journal of Legal Studies';
			m.ISSN = '1973-2937';
			delete m.tags;
			if (ctx.tooOld(m.date)) continue;
			ref.landing = false;
			yield ref;
		}
		if (!ctx.cancelled && ctx._oaiResponseDate) {
			let d = new Date(ctx._oaiResponseDate);
			if (!isNaN(d)) {
				d.setUTCDate(d.getUTCDate() - 1);
				state.oaiFrom = d.toISOString().slice(0, 10);
			}
		}
	},

	/** PDF: ORIGINAL bitstream listed in the ORE record */
	async resolve(ctx, ref) {
		if (!ref.oaiIdentifier || (ref.pdfUrls && ref.pdfUrls.length)) return;
		let endpoint = ctx.params.endpoint || 'https://cadmus.eui.eu/server/oai/request';
		let doc = await ctx.getXML(`${endpoint}?verb=GetRecord&metadataPrefix=ore&identifier=${encodeURIComponent(ref.oaiIdentifier)}`);
		let urls = [];
		for (let link of JCAdapters.xml(doc, 'link')) {
			if (!/aggregates$/.test(link.getAttribute('rel') || '')) continue;
			let href = link.getAttribute('href') || '';
			let m = /\/bitstreams\/([0-9a-f-]{36})\//.exec(href);
			if (!m) continue;
			let u = new URL(href);
			let api = `${u.origin}/server/api/core/bitstreams/${m[1]}/content`;
			if (/pdf/i.test(link.getAttribute('type') || '')) urls.unshift(api);
			else urls.push(api);
		}
		ref.pdfUrls = urls;
	},
});
