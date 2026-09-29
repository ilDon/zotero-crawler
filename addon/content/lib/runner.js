/* global Zotero, ChromeUtils, IOUtils, PathUtils, DOMParser, JCHtmlPdf, JCUtil, JCAdapters, JCResolver, JCStore, JCImporter */
/* exported JCRunner, JCEvents */

var { setTimeout: jcSetTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');

var JCEvents = {
	_listeners: new Map(),
	on(name, fn) {
		if (!this._listeners.has(name)) this._listeners.set(name, new Set());
		this._listeners.get(name).add(fn);
		return () => this._listeners.get(name).delete(fn);
	},
	emit(name, data) {
		for (let fn of this._listeners.get(name) || []) {
			try {
				fn(data);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},
};

/**
 * Runs the adapters inside Zotero: builds their ctx (HTTP through Zotero, hidden browser
 * for bot-protected pages), processes the refs they yield and records everything in JCStore.
 */
var JCRunner = {
	PREF: 'extensions.journal-crawler.',
	// pages served instead of the content by Cloudflare, Anubis and similar
	CHALLENGE_RE: /<title>\s*(just a moment|attention required|un momento|checking your browser|controllo se sei un robot|making sure you(&#39;|')re not a bot)|id="anubis|anubis_challenge/i,
	CHALLENGE_BODY_RE: /cf-chl-|cf_chl_opt|challenge-platform/i,

	isChallenge(res) {
		// AWS WAF: empty 202 with a challenge header
		if (res.status === 202 && /challenge/i.test(res.headers.get('x-amzn-waf-action') || '')) return true;
		if (!/html/i.test(res.contentType)) return false;
		let head = res.text.slice(0, 8000);
		return this.CHALLENGE_RE.test(head) || ([403, 429, 503].includes(res.status) && this.CHALLENGE_BODY_RE.test(head));
	},

	running: false,
	cancelled: false,
	status: new Map(), // journalId -> {state, found, processed, added, duplicates, errors, current}
	session: null, // the current or last run: {ids, dryRun, started, finished}
	log: [], // recent lines, for the UI
	_lastHit: new Map(), // host -> time of the last request
	_hostQueue: new Map(), // host -> promise chain (one request at a time per host)

	/** Global setting (see JCStore.SETTINGS); devLimit is a Zotero pref used only by tests */
	pref(name, def) {
		let v = name === 'devLimit' ? Zotero.Prefs.get(this.PREF + name, true) : JCStore.getSetting(name);
		return v === undefined || v === null || v === '' ? def : v;
	},

	/** First year to download for a journal (journal setting, else the global default), or null */
	sinceFor(journal) {
		let y = journal.sinceYear || parseInt(this.pref('defaultSinceYear', 0)) || null;
		return y && y > 1900 ? y : null;
	},

	_log(journal, msg, level = 'info') {
		let line = `${new Date().toLocaleTimeString()} ${journal ? '[' + journal.title + '] ' : ''}${msg}`;
		this.log.push({ level, line });
		if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
		if (level !== 'info') Zotero.debug('Journal Crawler: ' + line);
		JCEvents.emit('log', { level, line });
	},

	_setStatus(journalId, patch) {
		let s = this.status.get(journalId) || { state: 'idle', found: 0, processed: 0, added: 0, duplicates: 0, errors: 0, current: '' };
		Object.assign(s, patch);
		this.status.set(journalId, s);
		JCEvents.emit('status', { journalId, status: s });
	},

	// ---- HTTP ----

	async _throttle(url, delayMs) {
		let host = new URL(url).host;
		let prev = this._hostQueue.get(host) || Promise.resolve();
		let release;
		let mine = new Promise(r => (release = r));
		this._hostQueue.set(host, prev.then(() => mine));
		await prev;
		let wait = (this._lastHit.get(host) || 0) + delayMs - Date.now();
		if (wait > 0) await new Promise(r => jcSetTimeout(r, wait));
		this._lastHit.set(host, Date.now());
		return release;
	},

	_wrapResponse(status, url, contentType, bytes, getHeader) {
		let text = null;
		return {
			status,
			url,
			contentType,
			bytes,
			headers: { get: name => getHeader(name) },
			get text() {
				if (text === null) text = JCUtil.decode(bytes, contentType);
				return text;
			},
			json() {
				return JSON.parse(this.text);
			},
			doc() {
				let doc = new DOMParser().parseFromString(this.text, 'text/html');
				doc.__url = url;
				return doc;
			},
		};
	},

	async _httpRequest(url, o, delayMs) {
		let lastErr;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.cancelled) throw new Error('cancelled');
			let release = await this._throttle(url, delayMs);
			try {
				let headers = { 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', ...(o.headers || {}) };
				let xhr = await Zotero.HTTP.request(o.method || 'GET', url, {
					headers,
					body: o.body,
					responseType: 'arraybuffer',
					successCodes: false,
					timeout: 90000,
					errorDelayMax: 0,
				});
				let status = xhr.status;
				if (status === 429 || status >= 500) {
					lastErr = new Error(`HTTP ${status} ${url}`);
					release();
					await Zotero.Promise.delay(4000 * (attempt + 1));
					continue;
				}
				let bytes = new Uint8Array(xhr.response || new ArrayBuffer(0));
				return this._wrapResponse(status, xhr.responseURL || url, xhr.getResponseHeader('Content-Type') || '', bytes,
					name => xhr.getResponseHeader(name));
			}
			catch (e) {
				lastErr = e;
				release();
				release = null;
				await Zotero.Promise.delay(3000 * (attempt + 1));
			}
			finally {
				if (release) release();
			}
		}
		throw lastErr;
	},

	/** Render a page in Zotero's hidden browser, waiting for bot challenges to clear */
	async _browserDocument(url, delayMs) {
		const { HiddenBrowser } = ChromeUtils.importESModule('chrome://zotero/content/HiddenBrowser.mjs');
		let release = await this._throttle(url, delayMs);
		let browser;
		try {
			let customUserAgent = Zotero.VersionHeader.getPlainFirefoxUA ? Zotero.VersionHeader.getPlainFirefoxUA() : undefined;
			browser = new HiddenBrowser({ customUserAgent });
			await browser._createdPromise;
			await browser.load(url);
			let data;
			for (let i = 0; i < 30; i++) {
				await Zotero.Promise.delay(1000);
				data = await browser.getPageData(['documentHTML']);
				let head = String(data.documentHTML).slice(0, 8000);
				if (!this.CHALLENGE_RE.test(head) && !this.CHALLENGE_BODY_RE.test(head)) break;
			}
			let finalUrl = browser.currentURI ? browser.currentURI.spec : url;
			let html = String(data.documentHTML || '');
			let bytes = new TextEncoder().encode(html);
			return this._wrapResponse(200, finalUrl, 'text/html; charset=utf-8', bytes, () => null);
		}
		finally {
			if (browser) browser.destroy();
			release();
		}
	},

	makeContext(journal, run) {
		let params = journal.params || {};
		let delayMs = params.delayMs || this.pref('delayMs', 1000);
		let since = this.sinceFor(journal);
		let pendingIssues = new Set();
		let hosts = new Set();
		if (params.plainUA !== false && journal.url) {
			try {
				hosts.add(new URL(journal.url).host);
			}
			catch (e) {}
		}
		let runner = this;
		let request = async (url, o = {}) => {
			let host = new URL(url).host;
			if (!hosts.has(host) && params.plainUA !== false) hosts.add(host);
			if (params.plainUA !== false && Zotero.VersionHeader.registerPlainUAHost) {
				Zotero.VersionHeader.registerPlainUAHost(host);
			}
			if (o.browser) return runner._browserDocument(url, delayMs);
			let res = await runner._httpRequest(url, o, delayMs);
			// bot challenge: render once in the hidden browser (its cookies then serve plain requests)
			if (!o.binary && runner.isChallenge(res)) {
				runner._log(journal, `bot check on ${host}, using the hidden browser`, 'warn');
				res = await runner._browserDocument(url, delayMs);
			}
			if (res.status >= 400 && !o.allowErrors) throw new Error(`HTTP ${res.status} ${url}`);
			return res;
		};
		let ctx = {
			journal,
			params,
			state: journal.state || {},
			since,
			util: JCUtil,
			get cancelled() {
				return runner.cancelled;
			},
			tooOld(date) {
				let y = JCUtil.yearOf(date);
				return !!(since && y && y < since);
			},
			request,
			async getText(url, o) {
				return (await request(url, o)).text;
			},
			async getJSON(url, o) {
				return (await request(url, o)).json();
			},
			async getDoc(url, o = {}) {
				return (await request(url, { ...o, browser: o.browser || params.browser })).doc();
			},
			async getXML(url, o) {
				let r = await request(url, o);
				let doc = new DOMParser().parseFromString(JCUtil.cleanXml(r.text), 'text/xml');
				if (doc.querySelector('parsererror')) throw new Error(`Invalid XML from ${r.url}`);
				doc.__url = r.url;
				return doc;
			},
			async isSeen(key) {
				if (run.dryRun) return false;
				return JCStore.isSeen(journal.id, JCUtil.normalizeUrl(key), params.pdfWaitDays);
			},
			async isIssueDone(key) {
				if (run.dryRun) return false;
				return JCStore.isIssueDone(journal.id, key);
			},
			markIssueDone(key) {
				pendingIssues.add(key);
			},
			incremental(n = 20) {
				let streak = 0;
				return {
					stop: false,
					async seen(key) {
						let s = await ctx.isSeen(key);
						streak = s ? streak + 1 : 0;
						if (streak >= n && ctx.state.complete) this.stop = true;
						return s;
					},
					complete() {
						ctx.state.complete = true;
					},
				};
			},
			log: msg => runner._log(journal, msg),
			warn: msg => runner._log(journal, msg, 'warn'),
			_pendingIssues: pendingIssues,
		};
		return ctx;
	},

	// ---- PDFs ----

	async _downloadPdf(ctx, ref) {
		let cands = ref.pdfCandidates || [];
		if (!cands.length) return null;
		ctx._pdfErrors = [];
		let pdf = await JCResolver.fetchPdf(ctx, cands, ref.url);
		if (pdf) return pdf;
		// a missing file (404, 410) is not a bot check: nothing a browser could do
		let missing = ctx._pdfErrors.length && ctx._pdfErrors.every(e => /HTTP (404|410)\b/.test(e));
		// Cloudflare and similar: let a hidden browser fetch it (Zotero's own mechanism)
		if (!missing && Zotero.BrowserRequest && Zotero.BrowserRequest.downloadPDF && this.pref('browserFallback', true)) {
			for (let url of cands.slice(0, 2)) {
				let dir = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
				let path = PathUtils.join(dir, 'download.pdf');
				try {
					await Zotero.BrowserRequest.downloadPDF(url, path);
					let bytes = await IOUtils.read(path);
					if (JCUtil.isPdfBytes(bytes)) return { url, bytes };
				}
				catch (e) {
					ctx.warn(`browser download ${url}: ${e.message}`);
				}
				finally {
					await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
				}
			}
		}
		return null;
	},

	/** A web page printed to PDF ({url, bytes}), or null */
	async _renderPdf(ctx, url) {
		let dir = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
		let path = PathUtils.join(dir, 'page.pdf');
		try {
			let customUserAgent = Zotero.VersionHeader.getPlainFirefoxUA ? Zotero.VersionHeader.getPlainFirefoxUA() : undefined;
			await JCHtmlPdf.render(url, path, { customUserAgent });
			let bytes = await IOUtils.read(path);
			return JCUtil.isPdfBytes(bytes) ? { url, bytes } : null;
		}
		catch (e) {
			ctx.warn(`conversione in PDF di ${url}: ${e.message}`);
			return null;
		}
		finally {
			await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
		}
	},

	// ---- processing ----

	/**
	 * Resolve, dedupe, download and import one ref.
	 * @returns {Promise<string>} status recorded: added | duplicate | nopdf | error | old
	 */
	async processRef(ctx, adapter, journal, ref, lazyCollection, run) {
		let key = JCUtil.normalizeUrl(ref.key || ref.url || ref.pdfUrl);
		try {
			await JCResolver.resolve(ctx, adapter, ref);
			if (!ref.meta.title) throw new Error('no title');
			if (ctx.tooOld(ref.meta.date)) return 'old';
			this._setStatus(journal.id, { current: ref.meta.title });
			let dup = await JCImporter.findDuplicate(ref);
			if (dup && JCImporter.hasPdf(dup)) {
				let collection = await lazyCollection.get();
				await JCImporter.addToCollection(dup, collection);
				await JCStore.recordArticle(journal.id, key, { ref, status: 'duplicate', libraryID: dup.libraryID, itemKey: dup.key });
				ctx.log(`già in libreria: ${ref.meta.title}`);
				return 'duplicate';
			}
			let pdf = await this._downloadPdf(ctx, ref);
			// sites (or single articles) published as HTML only: the page is converted to PDF
			if (!pdf && (ctx.params.htmlToPdf || ref.htmlToPdf) && ref.url) {
				pdf = await this._renderPdf(ctx, ref.url);
				if (pdf) ctx.log(`pagina convertita in PDF: ${ref.meta.title}`);
			}
			if (!pdf) {
				let err = ref.pdfCandidates.length ? 'PDF not available yet: ' + ref.pdfCandidates[0] : 'no PDF link found';
				if (dup) {
					await JCImporter.addToCollection(dup, await lazyCollection.get());
					await JCStore.recordArticle(journal.id, key, { ref, status: 'duplicate', libraryID: dup.libraryID, itemKey: dup.key });
					return 'duplicate';
				}
				if (this.pref('importWithoutPdf', false)) {
					let item = await JCImporter.createItem(ref, journal, await lazyCollection.get());
					await JCStore.recordArticle(journal.id, key, { ref, status: 'nopdf', libraryID: item.libraryID, itemKey: item.key, error: err });
				}
				else {
					await JCStore.recordArticle(journal.id, key, { ref, status: 'nopdf', error: err });
				}
				ctx.warn(`${err} (${ref.meta.title})`);
				return 'nopdf';
			}
			ref.pdfUsed = pdf.url;
			let collection = await lazyCollection.get();
			let item = dup || await JCImporter.createItem(ref, journal, collection);
			if (dup) await JCImporter.addToCollection(dup, collection);
			await JCImporter.attachPdf(item, pdf.bytes, pdf.url);
			await JCStore.recordArticle(journal.id, key, { ref, status: dup ? 'duplicate' : 'added', libraryID: item.libraryID, itemKey: item.key });
			ctx.log(`${dup ? 'PDF aggiunto a voce esistente' : 'aggiunto'}: ${ref.meta.title}`);
			return dup ? 'duplicate' : 'added';
		}
		catch (e) {
			if (this.cancelled) throw e;
			ctx.warn(`errore su ${ref.url || ref.pdfUrl}: ${e.message}`);
			await JCStore.recordArticle(journal.id, key, { ref, status: 'error', error: e.message });
			return 'error';
		}
	},

	async runJournal(journal, run) {
		let adapter = JCAdapters.get(journal.adapter);
		let counters = { found: 0, processed: 0, added: 0, duplicates: 0, errors: 0 };
		let lines = [];
		let unsub = JCEvents.on('log', ({ line }) => {
			if (line.includes(`[${journal.title}]`)) lines.push(line);
		});
		this._setStatus(journal.id, { state: 'running', ...counters, current: '' });
		let runId = run.dryRun ? null : await JCStore.startRun(journal.id);
		let status = 'ok';
		try {
			if (!adapter) throw new Error(`adapter "${journal.adapter}" non disponibile`);
			// a lower cutoff than last time invalidates the adapter's cursors
			let since = this.sinceFor(journal);
			let state = journal.state || {};
			if (!run.dryRun && state.__since !== undefined && (since === null ? state.__since !== null : state.__since !== null && since < state.__since)) {
				this._log(journal, 'anno di partenza anticipato: riparto dall\'inizio dell\'archivio');
				state = {};
			}
			journal.state = state;
			let ctx = this.makeContext(journal, run);
			// created when the first article is imported, not for journals with nothing new
			let collection = run.dryRun ? null : {
				_c: null,
				async get() {
					if (!this._c) {
						this._c = await JCImporter.collectionFor(journal);
						if (this._c.key !== journal.collectionKey) {
							journal.collectionKey = this._c.key;
							await JCStore.setJournalFields(journal.id, { collectionKey: this._c.key });
						}
					}
					return this._c;
				},
			};
			let issueErrors = new Set();
			let processed = new Set();
			let handle = async (ref) => {
				let key = JCUtil.normalizeUrl(ref.key || ref.url || ref.pdfUrl);
				if (!key || processed.has(key)) return;
				processed.add(key);
				counters.found++;
				this._setStatus(journal.id, { found: counters.found });
				if (run.dryRun) {
					if (counters.found <= 3) await JCResolver.resolve(ctx, adapter, ref);
					let m = ref.meta || {};
					ctx.log(`trovato: ${m.date || '????'} | ${m.title || '(senza titolo)'} | ${(ref.pdfCandidates || ref.pdfUrls || [ref.pdfUrl]).filter(Boolean)[0] || 'PDF da cercare nella pagina'}`);
					if (counters.found === 1 && ref.pdfCandidates && ref.pdfCandidates.length) {
						let pdf = await JCResolver.fetchPdf(ctx, ref.pdfCandidates, ref.url);
						ctx.log(pdf ? `PDF OK (${Math.round(pdf.bytes.length / 1024)} KB)` : 'PDF non scaricabile con richiesta semplice (in esecuzione reale si prova il browser nascosto)');
					}
					counters.processed++;
					this._setStatus(journal.id, { ...counters });
					return;
				}
				let r = await this.processRef(ctx, adapter, journal, ref, collection, run);
				counters.processed++;
				if (r === 'added') counters.added++;
				else if (r === 'duplicate') counters.duplicates++;
				else if (r === 'error' || r === 'nopdf') {
					counters.errors++;
					if (ref.issueKey) issueErrors.add(ref.issueKey);
				}
				this._setStatus(journal.id, { ...counters });
			};
			// first, articles that failed last time
			if (!run.dryRun) {
				for (let ref of await JCStore.getRetryable(journal.id, journal.params && journal.params.pdfWaitDays)) {
					if (this.cancelled) break;
					await handle(ref);
				}
			}
			for await (let ref of adapter.discover(ctx)) {
				if (this.cancelled) break;
				if (!run.dryRun && await JCStore.isSeen(journal.id, JCUtil.normalizeUrl(ref.key || ref.url || ref.pdfUrl), journal.params && journal.params.pdfWaitDays)) continue;
				await handle(ref);
				let limit = run.dryRun ? (run.limit || 15) : (run.limit || +this.pref('devLimit', 0));
				if (limit && counters.found >= limit) break;
			}
			if (this.cancelled) status = 'cancelled';
			if (!run.dryRun) {
				let done = [...ctx._pendingIssues].filter(k => !issueErrors.has(k));
				await JCStore.markIssuesDone(journal.id, done);
				if (!this.cancelled) {
					ctx.state.__since = this.sinceFor(journal);
					await JCStore.setJournalFields(journal.id, { state: ctx.state, lastSuccess: JCStore.now(), lastError: null });
				}
			}
			this._log(journal, `${run.dryRun ? 'prova: ' : ''}${counters.found} trovati, ${counters.added} aggiunti, ${counters.duplicates} già presenti, ${counters.errors} non riusciti`);
		}
		catch (e) {
			status = this.cancelled ? 'cancelled' : 'error';
			if (!this.cancelled) {
				this._log(journal, `interrotto: ${e.message}`, 'error');
				Zotero.logError(e);
				if (!run.dryRun) await JCStore.setJournalFields(journal.id, { lastError: String(e.message).slice(0, 500) });
			}
		}
		finally {
			unsub();
			if (!run.dryRun) {
				await JCStore.setJournalFields(journal.id, { lastRun: JCStore.now() });
				await JCStore.finishRun(runId, { status, ...counters, log: lines });
			}
			this._setStatus(journal.id, { state: status === 'ok' ? 'done' : status, current: '' });
			JCEvents.emit('journal-finished', { journalId: journal.id });
		}
		return counters;
	},

	/**
	 * Run the given journals (default: all enabled), a few at a time.
	 * @param {Object} [opts] - {journalIds, dryRun, limit}
	 */
	async run(opts = {}) {
		if (this.running) throw new Error('already running');
		this.running = true;
		this.cancelled = false;
		JCEvents.emit('run', { running: true, dryRun: !!opts.dryRun });
		let totals = { found: 0, added: 0, duplicates: 0, errors: 0 };
		try {
			let all = await JCStore.listJournals();
			let journals = opts.journalIds
				? all.filter(j => opts.journalIds.includes(j.id))
				: all.filter(j => j.enabled);
			this.session = { ids: journals.map(j => j.id), dryRun: !!opts.dryRun, started: Date.now(), finished: null };
			for (let j of journals) this._setStatus(j.id, { state: 'queued', found: 0, processed: 0, added: 0, duplicates: 0, errors: 0, current: '' });
			this._log(null, `${opts.dryRun ? 'Prova' : 'Avvio'}: ${journals.length} riviste`);
			let queue = [...journals];
			let parallel = Math.max(1, Math.min(8, +this.pref('parallel', 3)));
			let worker = async () => {
				while (queue.length && !this.cancelled) {
					let j = queue.shift();
					let c = await this.runJournal(j, opts);
					for (let k of Object.keys(totals)) totals[k] += c[k] || 0;
				}
			};
			await Promise.all(Array.from({ length: parallel }, worker));
			for (let j of queue) this._setStatus(j.id, { state: 'idle' });
			this._log(null, `${this.cancelled ? 'Interrotto' : 'Finito'}: ${totals.added} articoli aggiunti, ${totals.duplicates} già presenti, ${totals.errors} non riusciti`);
		}
		finally {
			this.running = false;
			if (this.session) this.session.finished = Date.now();
			JCEvents.emit('run', { running: false, totals });
		}
		return totals;
	},

	stop() {
		if (this.running) {
			this.cancelled = true;
			this._log(null, 'Interruzione richiesta…');
		}
	},
};
