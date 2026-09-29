/* global JCUtil */
/* exported JCAdapters */

/**
 * Registry of site adapters.
 *
 * An adapter knows how to list the articles of one kind of site. It is an object
 *   {
 *     id: 'ojs',                          // stored in journals.adapter
 *     label: 'OJS (OAI-PMH)',
 *     description: '…',                   // shown in the journal editor
 *     params: { base: 'URL …', … },       // documented parameters (journals.params)
 *     async *discover(ctx) { yield ref }, // newest first, when the site allows it
 *     async resolve(ctx, ref) { … },      // optional: complete a ref before import
 *   }
 *
 * A ref describes one article:
 *   {
 *     key,        // stable id within the journal (default: normalized url or pdfUrl)
 *     url,        // landing page, if any
 *     pdfUrl,     // direct PDF link, if known
 *     meta,       // Zotero fields: title, creators[], date, volume, issue, pages, DOI,
 *                 // abstractNote, language, ISSN, tags[], itemType, extra
 *     issueKey,   // the issue the article belongs to (see ctx.markIssueDone)
 *     landing,    // true: read citation_* metadata from the landing page before import
 *   }
 *
 * The context passed to adapters (built by runner.js in Zotero, by test/harness.mjs in Node):
 *   ctx.journal            {slug, title, url, params}
 *   ctx.params             journal.params (object)
 *   ctx.state              per-journal object persisted after the run (cursors, flags)
 *   ctx.since              first year to download (number) or null for everything
 *   ctx.tooOld(date)       true if the date is before ctx.since
 *   ctx.request(url, opts) → {status, url, contentType, headers: {get(name)}, bytes, text, json(), doc()}
 *                          opts: {method, headers, body, browser (render in a hidden browser, Zotero only)}
 *   ctx.getText(url, opts), ctx.getJSON(url, opts), ctx.getDoc(url, opts) (doc.URL-like: doc.__url)
 *   ctx.getXML(url, opts)  XML Document
 *   ctx.isSeen(key)        true if the article was already processed in an earlier run
 *   ctx.isIssueDone(key)   true if every article of that issue was processed in an earlier run
 *   ctx.markIssueDone(key) mark the issue done at the end of the run, if none of its articles failed
 *                          (never mark the latest issue: it may still grow)
 *   ctx.incremental(n)     helper for sites that list articles newest first without issues, see below
 *   ctx.log(msg), ctx.warn(msg)
 *   ctx.cancelled          true when the user stopped the run
 *   ctx.util               JCUtil
 *
 * incremental(n) returns {seen(key) → Promise<bool>, stop, complete()}: seen() also counts
 * consecutive already-seen articles; stop becomes true after n of them once a full crawl
 * (down to ctx.since) has completed before — call complete() when the crawl reaches the end
 * of the archive or ctx.since.
 */
var JCAdapters = {
	_adapters: new Map(),

	register(adapter) {
		if (!adapter || !adapter.id || typeof adapter.discover !== 'function') {
			throw new Error('Invalid adapter');
		}
		this._adapters.set(adapter.id, adapter);
	},

	get(id) {
		return this._adapters.get(id) || null;
	},

	list() {
		return [...this._adapters.values()].sort((a, b) => a.id.localeCompare(b.id));
	},

	// ---- helpers shared by adapters ----

	/** Direct child/descendant elements of an XML node by local name (namespace prefix agnostic) */
	xml(el, localName) {
		let out = [];
		if (!el) return out;
		// querySelectorAll('*') rather than getElementsByTagName: the latter ignores '*' in linkedom
		for (let c of el.querySelectorAll('*')) {
			if (this.localName(c) === localName) out.push(c);
		}
		return out;
	},

	localName(el) {
		return String(el.localName || el.tagName || '').replace(/^.*:/, '');
	},

	xmlText(el, localName) {
		let n = this.xml(el, localName)[0];
		return n ? JCUtil.text(n) : '';
	},

	/**
	 * Iterate the records of an OAI-PMH ListRecords request, following resumption tokens.
	 * Yields {header: {identifier, datestamp, deleted, sets[]}, metadata: Element|null}.
	 * Sets ctx.state[stateKey] to the responseDate of the first page at the end, so the next
	 * run can ask only for records changed since then.
	 */
	async *oaiRecords(ctx, { endpoint, prefix = 'oai_dc', set = null, from = null }) {
		let params = new URLSearchParams({ verb: 'ListRecords', metadataPrefix: prefix });
		if (set) params.set('set', set);
		if (from) params.set('from', from);
		let url = endpoint + (endpoint.includes('?') ? '&' : '?') + params;
		let pages = 0;
		while (url && !ctx.cancelled) {
			let doc = await ctx.getXML(url);
			pages++;
			let err = this.xml(doc, 'error')[0];
			if (err) {
				let code = err.getAttribute('code');
				if (code === 'noRecordsMatch') return;
				throw new Error(`OAI-PMH ${code}: ${JCUtil.text(err)}`);
			}
			if (pages === 1) ctx._oaiResponseDate = this.xmlText(doc, 'responseDate');
			for (let rec of this.xml(doc, 'record')) {
				let header = this.xml(rec, 'header')[0];
				yield {
					header: {
						identifier: this.xmlText(header, 'identifier'),
						datestamp: this.xmlText(header, 'datestamp'),
						deleted: header && header.getAttribute('status') === 'deleted',
						sets: this.xml(header, 'setSpec').map(s => JCUtil.text(s)),
					},
					metadata: this.xml(rec, 'metadata')[0] || null,
				};
			}
			let token = this.xml(doc, 'resumptionToken')[0];
			let t = token ? JCUtil.text(token) : '';
			url = t ? endpoint + (endpoint.includes('?') ? '&' : '?') + new URLSearchParams({ verb: 'ListRecords', resumptionToken: t }) : null;
		}
	},

	/** Dublin Core fields of an oai_dc record: {title: [{text, lang}], creator: [...], …} */
	dublinCore(metadata) {
		let out = {};
		if (!metadata) return out;
		for (let el of metadata.querySelectorAll('*')) {
			let tag = String(el.tagName || '');
			if (!/^dc:/i.test(tag) && el.namespaceURI !== 'http://purl.org/dc/elements/1.1/') continue;
			let name = this.localName(el).toLowerCase();
			let text = JCUtil.text(el);
			if (!text) continue;
			(out[name] = out[name] || []).push({ text, lang: el.getAttribute('xml:lang') || '' });
		}
		return out;
	},

	/** Pick the value in the preferred language (e.g. 'ita' → it-IT), else the first one */
	pickLang(values, lang) {
		if (!values || !values.length) return '';
		let l2 = String(lang || '').slice(0, 2).toLowerCase();
		let map = { ita: 'it', eng: 'en', fra: 'fr', fre: 'fr', spa: 'es', deu: 'de', ger: 'de', por: 'pt' };
		l2 = map[String(lang || '').toLowerCase()] || l2;
		let hit = l2 && values.find(v => v.lang.toLowerCase().startsWith(l2));
		return (hit || values.find(v => !v.lang) || values[0]).text;
	},
};

if (typeof module !== 'undefined') module.exports = { JCAdapters };
