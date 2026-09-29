/* global JCUtil */
/* exported JCDetect */

/**
 * Guess adapter and params for a journal the user adds: OJS, Digital Commons, WordPress;
 * anything else gets the configurable crawler to be completed by hand.
 */
var JCDetect = {
	async detect(ctx, url) {
		let res = await ctx.request(url);
		let html = res.text;
		let final = res.url || url;
		let origin = new URL(final).origin;
		let generator = (/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)/i.exec(html) || [])[1] || '';

		// Open Journal Systems
		if (/Open Journal Systems/i.test(generator) || /\/index\.php\/[^/]+\/(issue|article|index)\b/.test(final + html.slice(0, 50000))) {
			let m = /^(https?:\/\/.+?\/index\.php\/[^/?#]+)/.exec(final)
				|| /(https?:\/\/[^"'\s]+?\/index\.php\/[^/"'\s]+)\/issue\/archive/.exec(html);
			let base = m ? m[1] : final.replace(/\/(index|issue\/.*|about.*)?\/?$/, '').replace(/\/(it|en)(_[A-Z]{2})?$/, '');
			let oai = false;
			try {
				let r = await ctx.request(base + '/oai?verb=Identify', { allowErrors: true });
				oai = r.status === 200 && /repositoryName/.test(r.text);
			}
			catch (e) {}
			return {
				adapter: 'ojs',
				params: oai ? { base } : { base, mode: 'archive' },
				notes: `OJS (${generator || 'versione sconosciuta'}), rilevato automaticamente${oai ? ' – OAI-PMH' : ' – archivio fascicoli'}.`,
			};
		}

		// Digital Commons (bepress)
		if (/bepress|digital commons/i.test(html.slice(0, 100000))) {
			let seg = new URL(final).pathname.split('/').filter(Boolean)[0] || '';
			return {
				adapter: 'oai',
				params: { endpoint: origin + '/do/oai/', set: 'publication:' + seg },
				notes: 'Digital Commons (bepress), rilevato automaticamente. I PDF possono essere protetti da Cloudflare: si usa il browser nascosto di Zotero.',
			};
		}

		// WordPress with the REST API
		if (/wp-content|wp-json/i.test(html)) {
			let base = origin;
			let link = /<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]+href=["']([^"']+)/i.exec(html);
			if (link) base = link[1].replace(/\/wp-json\/?$/, '');
			try {
				let r = await ctx.request(base + '/wp-json/wp/v2/posts?per_page=1', { allowErrors: true });
				if (r.status === 200 && /^\s*\[/.test(r.text)) {
					return {
						adapter: 'wordpress',
						params: { base },
						notes: 'WordPress, rilevato automaticamente: vengono presi gli articoli (post) che contengono un PDF. Se il sito mescola notizie e articoli, restringere con "type" o "query" (es. {"categories": "12"}).',
					};
				}
			}
			catch (e) {}
		}

		return {
			adapter: 'crawl',
			params: { start: final, landing: true },
			notes: 'Piattaforma non riconosciuta: configurato il crawler generico sulla pagina indicata (un PDF = un articolo). Probabilmente va completato con i selettori dei fascicoli (issueSelector) o degli articoli.',
		};
	},

	slugify(title) {
		return JCUtil.text(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
			.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'rivista';
	},
};

if (typeof module !== 'undefined') module.exports = { JCDetect };
