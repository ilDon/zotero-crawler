/* global JCUtil */
/* exported JCResolver */

/**
 * Completes a ref before import (landing page metadata, PDF candidates) and downloads
 * its PDF. Shared by the Zotero runner and the Node test harness.
 */
var JCResolver = {
	/** OJS viewer URLs → direct download */
	_fixPdfUrl(u) {
		if (!u) return u;
		let m = /^(.*\/article\/)view\/(\d+\/\d+)\/?$/.exec(u);
		if (m) return `${m[1]}download/${m[2]}`;
		return u;
	},

	/**
	 * Fill ref.meta from the landing page when needed and compute ref.pdfCandidates.
	 * @returns {Promise<Object>} the same ref
	 */
	async resolve(ctx, adapter, ref) {
		ref.meta = ref.meta || {};
		if (adapter && adapter.resolve) await adapter.resolve(ctx, ref);
		let cands = [...(ref.pdfUrls || []), ref.pdfUrl].filter(Boolean);
		let p = ctx.params;
		// params.pdfUrlTemplate also works backwards: the DOI from the PDF address
		if (!ref.meta.DOI && p.pdfUrlTemplate && cands.length) {
			let re = new RegExp('^' + p.pdfUrlTemplate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
				.replace('\\{doi_\\}', '([^/?#]+)').replace('\\{doi\\}', '(.+)') + '$');
			let m = re.exec(cands[0]);
			if (m) ref.meta.DOI = decodeURIComponent(p.pdfUrlTemplate.includes('{doi_}') ? m[1].replace(/_/g, '/') : m[1]);
		}
		// params.doiMeta: metadata registered with the DOI (title, authors, date, article page)
		if (p.doiMeta && ref.meta.DOI && !ref.doiMeta) {
			try {
				let csl = await ctx.getJSON('https://doi.org/' + encodeURI(ref.meta.DOI), { headers: { Accept: 'application/vnd.citationstyles.csl+json' } });
				ref.meta = JCUtil.mergeMeta(JCUtil.cslToMeta(csl), ref.meta);
				if (!ref.url && csl.URL && !/doi\.org/.test(csl.URL)) ref.url = csl.URL;
				ref.doiMeta = true;
			}
			catch (e) {
				ctx.warn(`metadati DOI ${ref.meta.DOI}: ${e.message}`);
			}
		}
		let needLanding = ref.url && ref.landing !== false
			&& (ref.landing || !ref.meta.title || !cands.length);
		if (needLanding) {
			let doc = await ctx.getDoc(ref.url, { browser: !!ctx.params.browser });
			let { meta, pdfUrl, hasScholarly } = JCUtil.parseEmbeddedMeta(doc, doc.__url);
			if (!hasScholarly) {
				// generic pages: og:title ("… - Site name") only when the adapter has no title
				meta = ref.meta.title ? {} : { title: meta.title };
			}
			ref.meta = ref.preferAdapterMeta ? JCUtil.mergeMeta(ref.meta, meta) : JCUtil.mergeMeta(meta, ref.meta);
			// the adapter may correct what the landing page says
			if (adapter && adapter.afterLanding) await adapter.afterLanding(ctx, ref, doc);
			if (pdfUrl) cands.unshift(pdfUrl);
			// params.doiSelector: the DOI is shown on the article page (link to doi.org or text)
			if (!ref.meta.DOI && ctx.params.doiSelector) {
				let el = doc.querySelector(ctx.params.doiSelector);
				let m = el && /(10\.\d{4,9}\/[^\s"<>]+)/.exec((el.getAttribute('href') || '') + ' ' + JCUtil.text(el));
				if (m) ref.meta.DOI = decodeURIComponent(m[1]).replace(/[.,;)]+$/, '');
			}
			// params.landingPdfSelector: where the PDF link is on the article page
			if (!cands.length && ctx.params.landingPdfSelector) {
				for (let a of doc.querySelectorAll(ctx.params.landingPdfSelector)) {
					let h = JCUtil.absUrl(a.getAttribute('href') || a.getAttribute('src') || a.getAttribute('data'), doc.__url);
					if (h) cands.push(h);
				}
			}
			// sites converted from HTML: PDFs linked in the text are cited documents, not the article
			if (!cands.length && ref.pdfFromPage !== false && !ctx.params.htmlToPdf && !ctx.params.pdfUrlTemplate) {
				let root = doc.querySelector(ctx.params.contentSelector || 'article, main, .entry-content, #content, .content') || doc;
				let links = JCUtil.pdfLinks(doc, doc.__url, root);
				if (links.length) cands.push(links[0].href);
			}
		}
		// params.pdfUrlTemplate: the PDF address follows from the DOI ({doi}, or {doi_} with / → _)
		if (!cands.length && ctx.params.pdfUrlTemplate && ref.meta.DOI) {
			cands.push(ctx.params.pdfUrlTemplate
				.replace('{doi_}', ref.meta.DOI.replace(/\//g, '_'))
				.replace('{doi}', ref.meta.DOI));
		}
		ref.pdfCandidates = [...new Set(cands.map(u => this._fixPdfUrl(u)))];
		return ref;
	},

	/**
	 * Download the first candidate that really is a PDF. An HTML answer (viewer page,
	 * download page) is searched once for the actual PDF link.
	 * @returns {Promise<{url, bytes}|null>}
	 */
	async fetchPdf(ctx, candidates, referrer) {
		let tried = new Set();
		let queue = [...candidates];
		let hops = 0;
		while (queue.length && hops < 6) {
			let url = queue.shift();
			if (!url || tried.has(url)) continue;
			tried.add(url);
			hops++;
			let res;
			try {
				res = await ctx.request(url, { headers: referrer ? { Referer: referrer } : {}, binary: true });
			}
			catch (e) {
				ctx.warn(`PDF ${url}: ${e.message}`);
				(ctx._pdfErrors = ctx._pdfErrors || []).push(e.message);
				continue;
			}
			if (JCUtil.isPdfBytes(res.bytes)) return { url: res.url || url, bytes: res.bytes };
			if (/html/i.test(res.contentType) || /^\s*</.test(res.text.slice(0, 200))) {
				let doc = res.doc();
				let here = res.url || url;
				let next = [];
				let meta = doc.querySelector('meta[name="citation_pdf_url"]');
				if (meta) next.push(meta.getAttribute('content'));
				for (let el of doc.querySelectorAll('iframe[src], embed[src], object[data]')) {
					next.push(el.getAttribute('src') || el.getAttribute('data'));
				}
				// pdf.js viewer pages: var DEFAULT_URL = '…pdf'
				let m = /DEFAULT_URL\s*=\s*["']([^"']+)["']/.exec(res.text);
				if (m) next.push(m[1]);
				// download links of the page itself; not any .pdf linked in the text (cited documents)
				let host = new URL(here).host;
				for (let a of doc.querySelectorAll('a.download, a[download], a.obj_galley_link, a[href*="/download/"], a[href$=".pdf"], a[href*=".pdf?"]')) {
					let h = JCUtil.absUrl(a.getAttribute('href'), here);
					if (h && new URL(h).host === host) next.push(h);
				}
				// pdf.js viewer: …/viewer.html?file=<pdf>
				for (let u of [...next]) {
					let fm = u && /[?&]file=([^&]+)/.exec(u);
					if (fm) next.unshift(decodeURIComponent(fm[1]));
				}
				queue.unshift(...next.map(h => this._fixPdfUrl(JCUtil.absUrl(h, here))).filter(Boolean));
			}
		}
		return null;
	},
};

if (typeof module !== 'undefined') module.exports = { JCResolver };
