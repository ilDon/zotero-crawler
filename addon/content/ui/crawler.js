/* global Zotero, Services, ChromeUtils, IOUtils */

/**
 * The journals window: list, editor, run controls, log.
 * The plugin's modules are reached through Zotero.JournalCrawler (see main.js).
 */
var JCWindow = {
	journals: [],
	selectedId: null, // the journal shown in the editor
	selected: new Set(), // the journals the "selezionate" buttons act on
	_anchor: null, // start of a shift-click range
	_rowOrder: [],
	sort: { key: 'title', dir: 1 },
	_unsub: [],

	get api() {
		return Zotero.JournalCrawler;
	},

	$(id) {
		return document.getElementById(id);
	},

	el(tag, attrs = {}, ...children) {
		let e = document.createElementNS('http://www.w3.org/1999/xhtml', tag);
		for (let [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k === 'class') e.className = v;
			else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
			else e.setAttribute(k, v === true ? 'true' : v);
		}
		for (let c of children.flat()) {
			if (c == null) continue;
			e.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
		}
		return e;
	},

	async init() {
		if (!this.api) {
			document.body.textContent = 'Journal Crawler non è attivo.';
			return;
		}
		let { runner, events } = this.api;
		// global settings
		this.$('since-year').value = runner.pref('defaultSinceYear', '') || '';
		this.$('collection-root').value = runner.pref('collectionRoot', 'Riviste');
		this.$('parallel').value = runner.pref('parallel', 3);
		this.$('since-year').addEventListener('change', e => this.setPref('defaultSinceYear', parseInt(e.target.value) || 0));
		this.$('collection-root').addEventListener('change', e => this.setPref('collectionRoot', e.target.value.trim() || 'Riviste'));
		this.$('parallel').addEventListener('change', e => this.setPref('parallel', Math.max(1, Math.min(8, parseInt(e.target.value) || 3))));

		this.$('run-all').addEventListener('click', () => this.run({}));
		this.$('run-selected').addEventListener('click', () => this.run({ journalIds: this.selection() }));
		this.$('test-selected').addEventListener('click', () => this.run({ journalIds: this.selection(), dryRun: true }));
		this.$('stop').addEventListener('click', () => runner.stop());
		this.$('add-journal').addEventListener('click', () => this.addJournal());
		this.$('import-json').addEventListener('click', () => this.importJSON());
		this.$('export-json').addEventListener('click', () => this.exportJSON());
		this.$('filter').addEventListener('input', () => this.renderList());
		this.$('filter-state').addEventListener('change', () => this.renderList());
		this.$('toggle-all-on').addEventListener('change', e => this.setAllEnabled(e.target.checked));
		// ⌘A / Ctrl+A in the list: select every listed journal
		this.$('journals').parentElement.addEventListener('keydown', (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
				e.preventDefault();
				this.selected = new Set(this._rowOrder);
				this.renderList();
			}
		});
		for (let th of document.querySelectorAll('#journals th[data-sort]')) {
			th.addEventListener('click', () => {
				let key = th.dataset.sort;
				this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : (key === 'title' || key === 'adapter' ? 1 : -1) };
				this.renderList();
			});
		}
		this.$('clear-log').addEventListener('click', () => {
			runner.log.length = 0;
			this.$('log').textContent = '';
		});

		// editor
		this.renderAdapterOptions();
		this.$('d-adapter').addEventListener('change', () => this.renderAdapterHelp());
		this.$('detail').addEventListener('submit', (e) => {
			e.preventDefault();
			this.saveDetail();
		});
		this.$('d-params').addEventListener('input', () => this.validateParams());
		// the articles filter is inside the form but is not a journal setting
		this.$('detail').addEventListener('input', (e) => {
			if (e.target.id !== 'articles-status') this._dirty = true;
		});
		this.$('d-detect').addEventListener('click', () => this.detect());
		this.$('d-open-url').addEventListener('click', () => {
			let u = this.$('d-url').value;
			if (u) Zotero.launchURL(u);
		});
		this.$('d-collection').addEventListener('click', () => this.showCollection());
		this.$('d-reset').addEventListener('click', () => this.resetJournal());
		this.$('d-delete').addEventListener('click', () => this.deleteJournal());
		for (let tab of document.querySelectorAll('.jc-tab')) {
			tab.addEventListener('click', () => this.showTab(tab.dataset.tab));
		}
		this.$('articles-status').addEventListener('change', () => this.renderArticles());

		// live updates
		this._unsub.push(events.on('log', entry => this.appendLog(entry)));
		this._unsub.push(events.on('status', () => this.scheduleRender()));
		this._unsub.push(events.on('journal-finished', () => this.reload()));
		this._unsub.push(events.on('run', () => {
			this.updateRunButtons();
			this.renderStatus();
		}));
		window.addEventListener('unload', () => this._unsub.forEach(fn => fn()));

		for (let entry of runner.log.slice(-500)) this.appendLog(entry);
		this.updateRunButtons();
		await this.reload();
		// the window may be opened while a run is going on
		this.renderStatus();
	},

	renderAdapterOptions() {
		let select = this.$('d-adapter');
		let current = select.value;
		select.textContent = '';
		for (let a of this.api.adapters.list()) {
			select.append(this.el('option', { value: a.id }, `${a.label || a.id} (${a.id})`));
		}
		if (current) select.value = current;
	},

	setPref(name, value) {
		this.api.store.setSetting(name, value).catch(e => Zotero.logError(e));
	},

	async reload() {
		this.journals = await this.api.store.listJournals();
		this.renderList();
		if (this.selectedId) {
			let j = this.journals.find(x => x.id === this.selectedId);
			if (j && !this._dirty) this.renderDetail(j);
			if (!j) this.select(null);
		}
	},

	scheduleRender() {
		if (this._renderTimer) return;
		this._renderTimer = setTimeout(() => {
			this._renderTimer = null;
			this.renderList();
			this.renderStatus();
		}, 300);
	},

	STATE_LABELS: { queued: 'in coda', running: 'in corso', done: 'fatto', error: 'errore', cancelled: 'interrotta', idle: 'non eseguita' },

	/** Bottom-left pane: the run as a whole, then one line per journal of the run */
	renderStatus() {
		let { runner } = this.api;
		let session = runner.session;
		if (!session) return;
		let rows = session.ids.map((id) => {
			let j = this.journals.find(x => x.id === id);
			return { id, title: j ? j.title : String(id), s: runner.status.get(id) || { state: 'queued' } };
		});
		let sum = k => rows.reduce((n, r) => n + (r.s[k] || 0), 0);
		let found = sum('found'), processed = sum('processed');
		let finished = rows.filter(r => !['queued', 'running'].includes(r.s.state)).length;
		let what = session.dryRun ? 'Prova' : 'Aggiornamento';
		let head = runner.running
			? `${what} in corso`
			: `${what} ${runner.cancelled ? 'interrotto' : 'concluso'} alle ${new Date(session.finished || Date.now()).toLocaleTimeString()}`;
		this.$('run-summary').textContent = `${head} · riviste ${finished}/${rows.length} · articoli ${processed}/${found}`
			+ (session.dryRun ? '' : ` · ${sum('added')} aggiunti · ${sum('duplicates')} già presenti · ${sum('errors')} non riusciti`);
		let bar = this.$('run-progress');
		bar.hidden = !runner.running;
		// articles found so far keep growing: the bar also counts finished journals
		let frac = rows.length ? (finished + rows.filter(r => r.s.state === 'running')
			.reduce((n, r) => n + (r.s.found ? r.s.processed / r.s.found : 0), 0)) / rows.length : 0;
		this.$('run-progress-fill').style.width = `${Math.round(Math.min(1, frac) * 100)}%`;

		let order = { running: 0, queued: 2 };
		rows.sort((a, b) => (order[a.s.state] ?? 1) - (order[b.s.state] ?? 1));
		let list = this.$('status-list');
		list.textContent = '';
		for (let r of rows) {
			let s = r.s;
			let counts = s.state === 'queued' ? this.STATE_LABELS.queued
				: `${s.processed || 0}/${s.found || 0}` + (session.dryRun ? '' : ` · +${s.added || 0}`
					+ (s.duplicates ? ` · ${s.duplicates} presenti` : '') + (s.errors ? ` · ${s.errors} falliti` : ''));
			let detail = s.state === 'running' ? (s.current || 'ricerca articoli…')
				: s.state === 'queued' ? '' : this.STATE_LABELS[s.state] || s.state;
			list.append(this.el('div', {
				class: 'st-row ' + s.state,
				title: `${r.title} — ${this.STATE_LABELS[s.state] || s.state}`,
				onclick: () => this.select(r.id),
			},
			this.el('span', { class: 'st-title' }, r.title),
			this.el('span', { class: 'st-count' }, counts),
			this.el('span', { class: 'st-current' }, detail)));
		}
	},

	selection() {
		let ids = [...this.selected].filter(id => this.journals.some(j => j.id === id));
		if (!ids.length && this.selectedId) ids = [this.selectedId];
		return ids;
	},

	/** Row click: plain, ⌘/Ctrl (toggle) or ⇧ (range), as in Zotero's lists */
	clickRow(id, e) {
		if (e.shiftKey && this._anchor != null && this._rowOrder.includes(this._anchor)) {
			let a = this._rowOrder.indexOf(this._anchor), b = this._rowOrder.indexOf(id);
			this.selected = new Set(this._rowOrder.slice(Math.min(a, b), Math.max(a, b) + 1));
		}
		else if (e.metaKey || e.ctrlKey) {
			this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
			this._anchor = id;
			if (!this.selected.has(id)) {
				this.renderList();
				return;
			}
		}
		else {
			this.selected = new Set([id]);
			this._anchor = id;
		}
		this.select(id, { keepSelection: true });
	},

	/** Enable or disable every listed journal */
	async setAllEnabled(enabled) {
		let rows = this.visibleJournals().filter(j => j.enabled !== enabled);
		for (let j of rows) await this.api.store.setJournalFields(j.id, { enabled });
		await this.reload();
	},

	visibleJournals() {
		let q = this.$('filter').value.trim().toLowerCase();
		let state = this.$('filter-state').value;
		return this.journals.filter((j) => {
			if (q && !`${j.title} ${j.url} ${j.adapter} ${j.slug}`.toLowerCase().includes(q)) return false;
			if (state === 'enabled' && !j.enabled) return false;
			if (state === 'disabled' && j.enabled) return false;
			if (state === 'errors' && !j.lastError && !(j.counts.error + j.counts.nopdf)) return false;
			return true;
		});
	},

	renderList() {
		let { runner } = this.api;
		let rows = this.visibleJournals();
		let val = (j) => {
			switch (this.sort.key) {
				case 'adapter': return j.adapter;
				case 'count': return j.counts.added + j.counts.duplicate;
				case 'failed': return j.counts.error + j.counts.nopdf;
				case 'lastRun': return j.lastRun || '';
				default: return j.title.toLowerCase();
			}
		};
		rows.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * this.sort.dir);
		let body = this.$('journals-body');
		body.textContent = '';
		for (let j of rows) {
			let st = runner.status.get(j.id);
			let stateText = '', stateClass = '';
			if (st && st.state === 'running') {
				stateText = `in corso: ${st.found} trovati, ${st.added} aggiunti${st.errors ? ', ' + st.errors + ' falliti' : ''}`;
				stateClass = 'running';
			}
			else if (st && st.state === 'queued') {
				stateText = 'in coda';
				stateClass = 'queued';
			}
			else if (j.lastError) {
				stateText = j.lastError;
				stateClass = 'error';
			}
			else if (st && st.state === 'done') {
				stateText = `fatto: ${st.added} nuovi`;
				stateClass = 'ok';
			}
			let tr = this.el('tr', {
				class: [this.selected.has(j.id) ? 'selected' : '', j.id === this.selectedId ? 'current' : '', j.enabled ? '' : 'disabled'].join(' '),
				onclick: (e) => {
					if (String(e.target.localName).toLowerCase() === 'input') return;
					this.clickRow(j.id, e);
				},
			},
			this.el('td', { class: 'c-on' }, this.el('input', {
				type: 'checkbox',
				checked: j.enabled,
				title: 'Attiva',
				onchange: async (e) => {
					await this.api.store.setJournalFields(j.id, { enabled: e.target.checked });
					this.reload();
				},
			})),
			this.el('td', { class: 'c-title', title: j.url || '' }, j.title),
			this.el('td', { class: 'c-adapter' }, j.adapter),
			this.el('td', { class: 'num' }, String(j.counts.added + j.counts.duplicate)),
			this.el('td', { class: 'num' + (j.counts.error + j.counts.nopdf ? ' warn' : '') }, String(j.counts.error + j.counts.nopdf || '')),
			this.el('td', { class: 'c-date' }, j.lastRun ? new Date(j.lastRun).toLocaleString() : 'mai'),
			this.el('td', { class: 'c-state ' + stateClass, title: stateText }, stateText));
			body.append(tr);
		}
		this._rowOrder = rows.map(j => j.id);
		this.$('list-empty').hidden = this.journals.length > 0;
		let enabled = this.journals.filter(j => j.enabled).length;
		this.$('list-count').textContent = `${rows.length} di ${this.journals.length} (${enabled} attive)`;
		// header checkbox: all listed journals enabled / some / none
		let on = rows.filter(j => j.enabled).length;
		let all = this.$('toggle-all-on');
		all.checked = rows.length > 0 && on === rows.length;
		all.indeterminate = on > 0 && on < rows.length;
		let n = this.selection().length;
		this.$('run-selected').textContent = n > 1 ? `Aggiorna selezionate (${n})` : 'Aggiorna selezionata';
		this.$('test-selected').textContent = n > 1 ? `Prova (${n})` : 'Prova';
	},

	select(id, { keepSelection = false } = {}) {
		if (this._dirty && id !== this.selectedId && !Services.prompt.confirm(window, 'Modifiche non salvate', 'Abbandonare le modifiche alla rivista?')) return;
		this._dirty = false;
		this.selectedId = id;
		if (!keepSelection) {
			this.selected = new Set(id ? [id] : []);
			this._anchor = id;
		}
		this.renderList();
		let j = this.journals.find(x => x.id === id);
		this.$('detail').hidden = !j;
		this.$('detail-empty').hidden = !!j;
		if (j) this.renderDetail(j);
	},

	renderDetail(j) {
		this.$('d-title').value = j.title;
		this.$('d-url').value = j.url || '';
		this.$('d-adapter').value = j.adapter;
		this.$('d-since').value = j.sinceYear || '';
		this.$('d-enabled').checked = j.enabled;
		this.$('d-params').value = JSON.stringify(j.params || {}, null, 2);
		this.$('d-notes').value = j.notes || '';
		this.$('d-instructions').value = j.instructions || '';
		this.$('d-survey').textContent = j.survey ? JSON.stringify(j.survey, null, 2) : 'Nessuna analisi salvata.';
		this.$('d-params-error').hidden = true;
		this.renderAdapterHelp();
		this.renderArticles();
		this.renderRuns();
	},

	renderAdapterHelp() {
		let a = this.api.adapters.get(this.$('d-adapter').value);
		let box = this.$('d-adapter-help');
		box.textContent = '';
		if (!a) {
			box.textContent = 'Adapter non disponibile in questa versione del plugin.';
			return;
		}
		box.append(this.el('div', {}, a.description || ''));
		let params = Object.entries(a.params || {});
		if (params.length) {
			box.append(this.el('ul', {}, params.map(([k, v]) => this.el('li', {}, this.el('code', {}, k), ': ', v))));
		}
		box.append(this.el('details', {}, this.el('summary', {}, 'Parametri validi per tutti i tipi'),
			this.el('ul', {}, Object.entries(this.COMMON_PARAMS).map(([k, v]) => this.el('li', {}, this.el('code', {}, k), ': ', v)))));
	},

	validateParams() {
		let err = this.$('d-params-error');
		try {
			let v = JSON.parse(this.$('d-params').value || '{}');
			if (typeof v !== 'object' || Array.isArray(v) || v === null) throw new Error('deve essere un oggetto { … }');
			err.hidden = true;
			return v;
		}
		catch (e) {
			err.hidden = false;
			err.textContent = 'JSON non valido: ' + e.message;
			return null;
		}
	},

	async saveDetail() {
		let j = this.journals.find(x => x.id === this.selectedId);
		if (!j) return;
		let params = this.validateParams();
		if (!params) return;
		let since = parseInt(this.$('d-since').value) || null;
		let changedAdapter = j.adapter !== this.$('d-adapter').value || JSON.stringify(j.params) !== JSON.stringify(params);
		await this.api.store.saveJournal({
			...j,
			title: this.$('d-title').value.trim() || j.title,
			url: this.$('d-url').value.trim(),
			adapter: this.$('d-adapter').value,
			params,
			sinceYear: since,
			enabled: this.$('d-enabled').checked,
			notes: this.$('d-notes').value,
			instructions: this.$('d-instructions').value,
		}, { fromUser: true });
		// new adapter or params: the cursors of the old configuration are meaningless
		if (changedAdapter) await this.api.store.setJournalFields(j.id, { state: {} });
		this._dirty = false;
		await this.reload();
	},

	async addJournal() {
		let title = { value: '' }, url = { value: 'https://' };
		if (!Services.prompt.prompt(window, 'Aggiungi rivista', 'Titolo della rivista:', title, null, {}) || !title.value.trim()) return;
		if (!Services.prompt.prompt(window, 'Aggiungi rivista', 'Indirizzo del sito (home page della rivista o pagina dei fascicoli):', url, null, {})) return;
		let { store, detect, runner } = this.api;
		let slug = detect.slugify(title.value);
		while (await store.getJournalBySlug(slug)) slug += '-2';
		let proposal = { adapter: 'crawl', params: { start: url.value.trim(), landing: true }, notes: '' };
		try {
			this.$('run-summary').textContent = 'Riconoscimento della piattaforma…';
			let ctx = runner.makeContext({ id: 0, title: title.value, url: url.value, params: {}, state: {} }, { dryRun: true });
			proposal = await detect.detect(ctx, url.value.trim());
			this.$('run-summary').textContent = `Riconosciuto: ${proposal.adapter}. Controlla i parametri e usa «Prova».`;
		}
		catch (e) {
			this.$('run-summary').textContent = 'Sito non raggiungibile per il riconoscimento: configurare a mano. ' + e.message;
		}
		let id = await store.saveJournal({
			slug,
			title: title.value.trim(),
			url: url.value.trim(),
			adapter: proposal.adapter,
			params: proposal.params,
			notes: proposal.notes,
			enabled: true,
		}, { fromUser: true });
		await this.reload();
		this.select(id);
	},

	async _pickFile(mode, title, defaultName) {
		const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
		let fp = new FilePicker();
		fp.init(window, title, mode === 'save' ? fp.modeSave : fp.modeOpen);
		fp.appendFilter('JSON', '*.json');
		if (defaultName) fp.defaultString = defaultName;
		let rv = await fp.show();
		return rv === fp.returnOK || rv === fp.returnReplace ? fp.file : null;
	},

	async importJSON() {
		let path = await this._pickFile('open', 'Importa riviste da JSON');
		if (!path) return;
		let { config } = this.api;
		let parsed;
		try {
			parsed = config.parse(await IOUtils.readUTF8(path));
		}
		catch (e) {
			Services.prompt.alert(window, 'Importa JSON', e.message);
			return;
		}
		let msg = `Il file contiene ${parsed.journals.length} riviste.`
			+ '\n\nLe riviste già presenti (stesso identificativo) vengono aggiornate; le altre restano invariate.';
		if (!Services.prompt.confirm(window, 'Importa JSON', msg)) return;
		try {
			let r = await config.import(parsed);
			let text = `${r.added} riviste aggiunte, ${r.updated} aggiornate.`;
			if (r.missingAdapters.length) text += `\n\nAdapter mancanti (le riviste che li usano non funzioneranno): ${r.missingAdapters.join(', ')}`;
			Services.prompt.alert(window, 'Importa JSON', text);
		}
		catch (e) {
			Services.prompt.alert(window, 'Importa JSON', 'Importazione non riuscita: ' + e.message);
		}
		await this.reload();
	},

	async exportJSON() {
		let ids = null;
		let sel = this.selection();
		if (sel.length > 1) {
			let ps = Services.prompt;
			let choice = ps.confirmEx(window, 'Esporta JSON', `Esportare le ${sel.length} riviste selezionate o tutte le riviste?`,
				ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL + ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING,
				`Selezionate (${sel.length})`, null, `Tutte (${this.journals.length})`, null, {});
			if (choice === 1) return;
			if (choice === 0) ids = sel;
		}
		let path = await this._pickFile('save', ids ? `Esporta ${ids.length} riviste selezionate` : 'Esporta tutte le riviste', 'riviste.json');
		if (!path) return;
		if (!path.endsWith('.json')) path += '.json';
		let data = await this.api.config.export(ids);
		await IOUtils.writeUTF8(path, JSON.stringify(data, null, 2) + '\n');
		this.$('run-summary').textContent = `Esportate ${data.journals.length} riviste in ${path}`;
	},

	async detect() {
		let url = this.$('d-url').value.trim();
		if (!url) return;
		let { detect, runner } = this.api;
		this.$('d-detect').disabled = true;
		try {
			let ctx = runner.makeContext({ id: 0, title: this.$('d-title').value, url, params: {}, state: {} }, { dryRun: true });
			let p = await detect.detect(ctx, url);
			this.$('d-adapter').value = p.adapter;
			this.$('d-params').value = JSON.stringify(p.params, null, 2);
			if (p.notes) this.$('d-notes').value = p.notes + (this.$('d-notes').value ? '\n' + this.$('d-notes').value : '');
			this._dirty = true;
			this.renderAdapterHelp();
		}
		catch (e) {
			Services.prompt.alert(window, 'Rileva automaticamente', 'Non è stato possibile analizzare il sito: ' + e.message);
		}
		finally {
			this.$('d-detect').disabled = false;
		}
	},

	async showCollection() {
		let j = this.journals.find(x => x.id === this.selectedId);
		if (!j) return;
		let c = await this.api.importer.collectionFor(j);
		if (c.key !== j.collectionKey) await this.api.store.setJournalFields(j.id, { collectionKey: c.key });
		let zp = Zotero.getActiveZoteroPane();
		if (zp) {
			await zp.collectionsView.selectCollection(c.id);
			Zotero.getMainWindow().focus();
		}
	},

	async resetJournal() {
		let j = this.journals.find(x => x.id === this.selectedId);
		if (!j) return;
		if (!Services.prompt.confirm(window, 'Dimentica download', `Dimenticare cosa è stato scaricato da «${j.title}»? Gli articoli già in Zotero restano; alla prossima esecuzione l'archivio viene ricontrollato e gli articoli già presenti vengono riconosciuti come duplicati.`)) return;
		await this.api.store.resetJournal(j.id);
		await this.reload();
	},

	async deleteJournal() {
		let j = this.journals.find(x => x.id === this.selectedId);
		if (!j) return;
		if (!Services.prompt.confirm(window, 'Elimina rivista', `Eliminare «${j.title}» dall'elenco? Gli articoli già in Zotero restano.`)) return;
		await this.api.store.deleteJournal(j.id);
		this._dirty = false;
		this.selected.delete(j.id);
		this.select(null);
		await this.reload();
	},

	showTab(name) {
		for (let t of document.querySelectorAll('.jc-tab')) t.classList.toggle('selected', t.dataset.tab === name);
		this.$('tab-articles').hidden = name !== 'articles';
		this.$('tab-runs').hidden = name !== 'runs';
		this.$('articles-status').hidden = name !== 'articles';
	},

	COMMON_PARAMS: {
		htmlToPdf: 'true: se un articolo non ha PDF, la sua pagina web viene convertita in PDF',
		landingPdfSelector: 'selettore CSS del link al PDF nella pagina dell\'articolo',
		doiSelector: 'selettore CSS dell\'elemento con il DOI nella pagina dell\'articolo',
		pdfUrlTemplate: 'indirizzo del PDF ricavato dal DOI: {doi}, oppure {doi_} con «/» sostituito da «_» (vale anche al contrario: il DOI dal nome del PDF)',
		doiMeta: 'true: titolo, autori, data e pagina dell\'articolo dai metadati registrati del DOI (doi.org)',
		pdfWaitDays: 'giorni per cui un articolo senza PDF viene ricontrollato (predefinito 60)',
		skipPattern: 'espressione regolare: salta gli articoli il cui titolo corrisponde',
		browser: 'true: le pagine vengono aperte nel browser nascosto di Zotero (controlli anti-bot, siti in JavaScript)',
		delayMs: 'pausa tra due richieste allo stesso sito, in millisecondi (predefinito 1000)',
	},

	STATUS_LABELS: { added: 'aggiunto', duplicate: 'già presente', nopdf: 'PDF in attesa', error: 'errore', skipped: 'saltato' },

	async renderArticles() {
		let id = this.selectedId;
		if (!id) return;
		let list = await this.api.store.listArticles(id, { status: this.$('articles-status').value || null, limit: 300 });
		let box = this.$('tab-articles');
		box.textContent = '';
		if (!list.length) {
			box.append(this.el('div', { class: 'muted' }, 'Nessun articolo.'));
			return;
		}
		box.append(this.el('table', { class: 'articles' }, this.el('tbody', {}, list.map(a => this.el('tr', {},
			this.el('td', { class: 'st st-' + a.status, title: a.error || '' }, this.STATUS_LABELS[a.status] || a.status),
			this.el('td', { class: 'c-date' }, a.date || ''),
			this.el('td', {},
				a.itemKey
					? this.el('a', { href: '#', onclick: (e) => {
						e.preventDefault();
						this.openItem(a.libraryID, a.itemKey);
					} }, a.title || a.key)
					: (a.title || a.key),
				a.error ? this.el('div', { class: 'err' }, a.error + (a.attempts > 1 ? ` (${a.attempts} tentativi)` : '')) : null),
			this.el('td', {}, this.el('a', { href: '#', title: a.url || a.pdfUrl || a.key, onclick: (e) => {
				e.preventDefault();
				Zotero.launchURL(a.url || a.pdfUrl || a.key);
			} }, '↗')),
			this.el('td', {}, (a.status === 'error' || a.status === 'nopdf' || a.status === 'added') ? this.el('a', {
				href: '#',
				title: 'Dimentica questo articolo: verrà cercato di nuovo alla prossima esecuzione',
				onclick: async (e) => {
					e.preventDefault();
					await this.api.store.forgetArticle(id, a.key);
					this.renderArticles();
				},
			}, '↺') : null))))));
	},

	async renderRuns() {
		let id = this.selectedId;
		if (!id) return;
		let runs = await this.api.store.listRuns(id);
		let box = this.$('tab-runs');
		box.textContent = '';
		if (!runs.length) {
			box.append(this.el('div', { class: 'muted' }, 'Mai eseguita.'));
			return;
		}
		for (let r of runs) {
			box.append(this.el('details', { class: 'run' },
				this.el('summary', {}, `${new Date(r.started).toLocaleString()} — ${r.status}: ${r.found} trovati, ${r.added} aggiunti, ${r.duplicates} già presenti, ${r.errors} non riusciti`),
				this.el('pre', {}, r.log || '')));
		}
	},

	openItem(libraryID, key) {
		let item = Zotero.Items.getByLibraryAndKey(libraryID, key);
		if (!item) return;
		let zp = Zotero.getActiveZoteroPane();
		if (zp) {
			zp.selectItem(item.id);
			Zotero.getMainWindow().focus();
		}
	},

	appendLog({ level, line }) {
		let log = this.$('log');
		let atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
		log.append(this.el('div', { class: 'log-' + level }, line));
		while (log.childNodes.length > 1500) log.firstChild.remove();
		if (atBottom) log.scrollTop = log.scrollHeight;
	},

	updateRunButtons() {
		let running = this.api.runner.running;
		for (let id of ['run-all', 'run-selected', 'test-selected']) this.$(id).disabled = running;
		this.$('stop').disabled = !running;
	},

	async run(opts) {
		if (opts.journalIds && !opts.journalIds.length) {
			Services.prompt.alert(window, 'Riviste', 'Seleziona almeno una rivista nell\'elenco (clic sulla riga; ⌘-clic o ⇧-clic per più riviste, ⌘A per tutte).');
			return;
		}
		if (opts.dryRun && opts.journalIds.length > 5
			&& !Services.prompt.confirm(window, 'Prova', `Provare ${opts.journalIds.length} riviste? Per ognuna vengono elencati fino a 15 articoli.`)) return;
		try {
			await this.api.runner.run(opts);
		}
		catch (e) {
			Services.prompt.alert(window, 'Riviste', e.message);
		}
		await this.reload();
	},
};

window.addEventListener('load', () => JCWindow.init().catch(e => Zotero.logError(e)));
