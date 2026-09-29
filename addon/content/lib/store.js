/* global Zotero, ChromeUtils, PathUtils, JCUtil */
/* exported JCStore */

/**
 * The plugin's own database, journal-crawler.sqlite next to zotero.sqlite.
 *
 *   journals  the journal list with adapter, params, per-journal settings and the
 *             adapter's persisted state (cursors)
 *   articles  every article met on a journal, with what happened to it; an article
 *             found again in a later run is skipped without visiting it
 *   issues    issues whose articles were all processed (skipped by the adapters)
 *   runs      history of runs, with counters and log
 *   jc_meta   plugin state and global settings (setting.<name>, JSON values)
 */
var JCStore = {
	FILE: 'journal-crawler.sqlite',
	// global settings, kept in the database so that they follow it (e.g. a synced data directory)
	SETTINGS: {
		defaultSinceYear: 2024,
		collectionRoot: 'Riviste',
		parallel: 3,
		delayMs: 1000,
		tag: '',
		importWithoutPdf: false,
		browserFallback: true,
	},
	_settings: {},
	MAX_ATTEMPTS: 3,
	// articles found without PDF are checked again for this long (the PDF may come later)
	PDF_WAIT_DAYS: 60,
	_conn: null,
	_opening: null,

	get path() {
		return PathUtils.join(Zotero.DataDirectory.dir, this.FILE);
	},

	async open() {
		if (this._conn) return this._conn;
		if (this._opening) return this._opening;
		this._opening = (async () => {
			const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
			let conn = await Sqlite.openConnection({ path: this.path });
			await this._createTables(conn);
			await this._loadSettings(conn);
			this._conn = conn;
			return conn;
		})();
		try {
			return await this._opening;
		}
		finally {
			this._opening = null;
		}
	},

	async close() {
		if (this._conn) {
			let c = this._conn;
			this._conn = null;
			await c.close();
		}
	},

	async _createTables(conn) {
		await conn.execute('PRAGMA foreign_keys = ON');
		await conn.execute(`CREATE TABLE IF NOT EXISTS journals (
			id INTEGER PRIMARY KEY,
			slug TEXT UNIQUE NOT NULL,
			title TEXT NOT NULL,
			url TEXT,
			adapter TEXT NOT NULL,
			params TEXT NOT NULL DEFAULT '{}',
			enabled INTEGER NOT NULL DEFAULT 1,
			since_year INTEGER,
			collection_key TEXT,
			notes TEXT,
			instructions TEXT,
			survey TEXT,
			state TEXT NOT NULL DEFAULT '{}',
			user_modified INTEGER NOT NULL DEFAULT 0,
			last_run TEXT,
			last_success TEXT,
			last_error TEXT,
			created TEXT,
			updated TEXT)`);
		await conn.execute(`CREATE TABLE IF NOT EXISTS articles (
			id INTEGER PRIMARY KEY,
			journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
			key TEXT NOT NULL,
			url TEXT,
			pdf_url TEXT,
			title TEXT,
			date TEXT,
			issue_key TEXT,
			status TEXT NOT NULL,
			library_id INTEGER,
			item_key TEXT,
			attempts INTEGER NOT NULL DEFAULT 1,
			error TEXT,
			ref TEXT,
			first_seen TEXT,
			updated TEXT,
			UNIQUE (journal_id, key))`);
		await conn.execute('CREATE INDEX IF NOT EXISTS articles_status ON articles(journal_id, status)');
		await conn.execute(`CREATE TABLE IF NOT EXISTS issues (
			journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
			key TEXT NOT NULL,
			done_at TEXT,
			PRIMARY KEY (journal_id, key))`);
		await conn.execute(`CREATE TABLE IF NOT EXISTS runs (
			id INTEGER PRIMARY KEY,
			journal_id INTEGER REFERENCES journals(id) ON DELETE CASCADE,
			started TEXT,
			finished TEXT,
			status TEXT,
			found INTEGER DEFAULT 0,
			added INTEGER DEFAULT 0,
			duplicates INTEGER DEFAULT 0,
			errors INTEGER DEFAULT 0,
			log TEXT)`);
		await conn.execute('CREATE TABLE IF NOT EXISTS jc_meta (key TEXT PRIMARY KEY, value TEXT)');
	},

	async _loadSettings(conn) {
		let rows = await conn.execute('SELECT key, value FROM jc_meta WHERE key LIKE ?', ['setting.%']);
		this._settings = {};
		for (let r of rows) {
			try {
				this._settings[r.getResultByIndex(0).slice(8)] = JSON.parse(r.getResultByIndex(1));
			}
			catch (e) {}
		}
	},

	/** A global setting (synchronous: loaded when the database is opened) */
	getSetting(name) {
		return name in this._settings ? this._settings[name] : this.SETTINGS[name];
	},

	async setSetting(name, value) {
		this._settings[name] = value;
		await this.setMeta('setting.' + name, JSON.stringify(value));
	},

	now() {
		return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
	},

	_journalFromRow(r) {
		let json = (s, def) => {
			try {
				return s ? JSON.parse(s) : def;
			}
			catch (e) {
				return def;
			}
		};
		let g = n => r.getResultByName(n);
		return {
			id: g('id'),
			slug: g('slug'),
			title: g('title'),
			url: g('url'),
			adapter: g('adapter'),
			params: json(g('params'), {}),
			enabled: !!g('enabled'),
			sinceYear: g('since_year'),
			collectionKey: g('collection_key'),
			notes: g('notes') || '',
			instructions: g('instructions') || '',
			survey: json(g('survey'), null),
			state: json(g('state'), {}),
			userModified: !!g('user_modified'),
			lastRun: g('last_run'),
			lastSuccess: g('last_success'),
			lastError: g('last_error'),
		};
	},

	// ---- journals ----

	async listJournals() {
		let conn = await this.open();
		let rows = await conn.execute('SELECT * FROM journals ORDER BY title COLLATE NOCASE');
		let journals = rows.map(r => this._journalFromRow(r));
		let counts = await conn.execute(`SELECT journal_id, status, COUNT(*) AS n FROM articles GROUP BY journal_id, status`);
		let byId = new Map(journals.map(j => [j.id, j]));
		for (let j of journals) j.counts = { added: 0, duplicate: 0, error: 0, nopdf: 0, skipped: 0 };
		for (let r of counts) {
			let j = byId.get(r.getResultByName('journal_id'));
			if (j) j.counts[r.getResultByName('status')] = r.getResultByName('n');
		}
		return journals;
	},

	async getJournal(id) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT * FROM journals WHERE id = ?', [id]);
		return rows.length ? this._journalFromRow(rows[0]) : null;
	},

	async getJournalBySlug(slug) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT * FROM journals WHERE slug = ?', [slug]);
		return rows.length ? this._journalFromRow(rows[0]) : null;
	},

	/** Insert or update a journal. Returns its id. */
	async saveJournal(j, { fromUser = false } = {}) {
		let conn = await this.open();
		let now = this.now();
		let vals = {
			slug: j.slug,
			title: j.title,
			url: j.url || null,
			adapter: j.adapter,
			params: JSON.stringify(j.params || {}),
			enabled: j.enabled === false ? 0 : 1,
			since_year: j.sinceYear || null,
			collection_key: j.collectionKey || null,
			notes: j.notes || null,
			instructions: j.instructions || null,
			survey: j.survey ? JSON.stringify(j.survey) : null,
			updated: now,
		};
		if (j.id) {
			let sets = Object.keys(vals).map(k => `${k} = :${k}`).join(', ');
			await conn.execute(`UPDATE journals SET ${sets}${fromUser ? ', user_modified = 1' : ''} WHERE id = :id`, { ...vals, id: j.id });
			return j.id;
		}
		vals.created = now;
		vals.user_modified = fromUser ? 1 : 0;
		let cols = Object.keys(vals);
		await conn.execute(`INSERT INTO journals (${cols.join(', ')}) VALUES (${cols.map(c => ':' + c).join(', ')})`, vals);
		let rows = await conn.execute('SELECT id FROM journals WHERE slug = ?', [j.slug]);
		return rows[0].getResultByIndex(0);
	},

	async setJournalFields(id, fields) {
		let conn = await this.open();
		let map = { enabled: 'enabled', sinceYear: 'since_year', collectionKey: 'collection_key', lastRun: 'last_run',
			lastSuccess: 'last_success', lastError: 'last_error', state: 'state' };
		let sets = [], vals = { id };
		for (let [k, v] of Object.entries(fields)) {
			let col = map[k];
			if (!col) throw new Error('Unknown field ' + k);
			sets.push(`${col} = :${col}`);
			vals[col] = k === 'state' ? JSON.stringify(v || {}) : typeof v === 'boolean' ? (v ? 1 : 0) : v;
		}
		if (sets.length) await conn.execute(`UPDATE journals SET ${sets.join(', ')} WHERE id = :id`, vals);
	},

	async deleteJournal(id) {
		let conn = await this.open();
		let j = await this.getJournal(id);
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM articles WHERE journal_id = ?', [id]);
			await conn.execute('DELETE FROM issues WHERE journal_id = ?', [id]);
			await conn.execute('DELETE FROM runs WHERE journal_id = ?', [id]);
			await conn.execute('DELETE FROM journals WHERE id = ?', [id]);
		});
	},

	/** Forget what was downloaded from a journal (next run starts over, duplicates are still detected) */
	async resetJournal(id) {
		let conn = await this.open();
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM articles WHERE journal_id = ?', [id]);
			await conn.execute('DELETE FROM issues WHERE journal_id = ?', [id]);
			await conn.execute("UPDATE journals SET state = '{}' WHERE id = ?", [id]);
		});
	},

	// ---- articles ----

	/** Status of an article key, or null if never met */
	async getArticle(journalId, key) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT status, attempts, item_key FROM articles WHERE journal_id = ? AND key = ?', [journalId, key]);
		if (!rows.length) return null;
		return { status: rows[0].getResultByIndex(0), attempts: rows[0].getResultByIndex(1), itemKey: rows[0].getResultByIndex(2) };
	},

	_waitCutoff(waitDays) {
		let d = new Date(Date.now() - (waitDays || this.PDF_WAIT_DAYS) * 86400000);
		return d.toISOString().replace(/\.\d+Z$/, 'Z');
	},

	/**
	 * true if the article needs no more work: done, failed three times, or still without
	 * PDF after the waiting period (waitDays, default PDF_WAIT_DAYS)
	 */
	async isSeen(journalId, key, waitDays) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT status, attempts, first_seen FROM articles WHERE journal_id = ? AND key = ?', [journalId, key]);
		if (!rows.length) return false;
		let [status, attempts, firstSeen] = [0, 1, 2].map(i => rows[0].getResultByIndex(i));
		if (status === 'error') return attempts >= this.MAX_ATTEMPTS;
		if (status === 'nopdf') return attempts >= this.MAX_ATTEMPTS && firstSeen < this._waitCutoff(waitDays);
		return true;
	},

	async recordArticle(journalId, key, { ref, status, libraryID, itemKey, error }) {
		let conn = await this.open();
		let now = this.now();
		let meta = (ref && ref.meta) || {};
		let refJson = null;
		if (status === 'error' || status === 'nopdf') {
			// kept to retry without the adapter having to find the article again
			let { key: k, url, pdfUrl, pdfUrls, meta: m, issueKey, landing, preferAdapterMeta } = ref || {};
			refJson = JSON.stringify({ key: k, url, pdfUrl, pdfUrls, meta: m, issueKey, landing, preferAdapterMeta });
		}
		await conn.execute(`INSERT INTO articles (journal_id, key, url, pdf_url, title, date, issue_key, status, library_id,
				item_key, attempts, error, ref, first_seen, updated)
			VALUES (:j, :key, :url, :pdf, :title, :date, :issue, :status, :lib, :item, 1, :error, :ref, :now, :now)
			ON CONFLICT (journal_id, key) DO UPDATE SET
				url = COALESCE(excluded.url, url), pdf_url = COALESCE(excluded.pdf_url, pdf_url),
				title = COALESCE(excluded.title, title), date = COALESCE(excluded.date, date),
				status = excluded.status, library_id = COALESCE(excluded.library_id, library_id),
				item_key = COALESCE(excluded.item_key, item_key), attempts = attempts + 1,
				error = excluded.error, ref = excluded.ref, updated = excluded.updated`, {
			j: journalId,
			key,
			url: (ref && ref.url) || null,
			pdf: (ref && (ref.pdfUsed || ref.pdfUrl)) || null,
			title: meta.title || null,
			date: meta.date || null,
			issue: (ref && ref.issueKey) || null,
			status,
			lib: libraryID || null,
			item: itemKey || null,
			error: error ? String(error).slice(0, 1000) : null,
			ref: refJson,
			now,
		});
	},

	/** Articles that failed in earlier runs and can be tried again */
	async getRetryable(journalId, waitDays) {
		let conn = await this.open();
		let rows = await conn.execute(`SELECT key, ref FROM articles WHERE journal_id = ? AND ref IS NOT NULL
			AND ((status = 'error' AND attempts < :max) OR (status = 'nopdf' AND (attempts < :max OR first_seen >= :cutoff)))`
			.replace('journal_id = ?', 'journal_id = :j'), { j: journalId, max: this.MAX_ATTEMPTS, cutoff: this._waitCutoff(waitDays) });
		let out = [];
		for (let r of rows) {
			try {
				out.push({ ...JSON.parse(r.getResultByIndex(1)), key: r.getResultByIndex(0) });
			}
			catch (e) {}
		}
		return out;
	},

	async listArticles(journalId, { status = null, limit = 500 } = {}) {
		let conn = await this.open();
		let rows = await conn.execute(`SELECT key, url, pdf_url, title, date, status, item_key, library_id, attempts, error, updated
			FROM articles WHERE journal_id = ? ${status ? 'AND status = ?' : ''} ORDER BY updated DESC LIMIT ${+limit}`,
		status ? [journalId, status] : [journalId]);
		return rows.map(r => ({
			key: r.getResultByName('key'),
			url: r.getResultByName('url'),
			pdfUrl: r.getResultByName('pdf_url'),
			title: r.getResultByName('title'),
			date: r.getResultByName('date'),
			status: r.getResultByName('status'),
			itemKey: r.getResultByName('item_key'),
			libraryID: r.getResultByName('library_id'),
			attempts: r.getResultByName('attempts'),
			error: r.getResultByName('error'),
			updated: r.getResultByName('updated'),
		}));
	},

	/** Allow an article to be downloaded again (e.g. after deleting it from Zotero) */
	async forgetArticle(journalId, key) {
		let conn = await this.open();
		await conn.execute('DELETE FROM articles WHERE journal_id = ? AND key = ?', [journalId, key]);
	},

	// ---- issues ----

	async isIssueDone(journalId, key) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT 1 FROM issues WHERE journal_id = ? AND key = ?', [journalId, key]);
		return rows.length > 0;
	},

	async markIssuesDone(journalId, keys) {
		if (!keys.length) return;
		let conn = await this.open();
		let now = this.now();
		await conn.executeTransaction(async () => {
			for (let k of keys) {
				await conn.execute('INSERT OR REPLACE INTO issues (journal_id, key, done_at) VALUES (?, ?, ?)', [journalId, k, now]);
			}
		});
	},

	// ---- runs ----

	async startRun(journalId) {
		let conn = await this.open();
		await conn.execute('INSERT INTO runs (journal_id, started, status) VALUES (?, ?, ?)', [journalId, this.now(), 'running']);
		let rows = await conn.execute('SELECT last_insert_rowid()');
		return rows[0].getResultByIndex(0);
	},

	async finishRun(runId, { status, found, added, duplicates, errors, log }) {
		let conn = await this.open();
		await conn.execute(`UPDATE runs SET finished = ?, status = ?, found = ?, added = ?, duplicates = ?, errors = ?, log = ?
			WHERE id = ?`, [this.now(), status, found, added, duplicates, errors, (log || []).join('\n').slice(-20000), runId]);
	},

	async listRuns(journalId, limit = 20) {
		let conn = await this.open();
		let rows = await conn.execute(`SELECT id, started, finished, status, found, added, duplicates, errors, log
			FROM runs WHERE journal_id = ? ORDER BY id DESC LIMIT ${+limit}`, [journalId]);
		return rows.map(r => ({
			id: r.getResultByName('id'),
			started: r.getResultByName('started'),
			finished: r.getResultByName('finished'),
			status: r.getResultByName('status'),
			found: r.getResultByName('found'),
			added: r.getResultByName('added'),
			duplicates: r.getResultByName('duplicates'),
			errors: r.getResultByName('errors'),
			log: r.getResultByName('log'),
		}));
	},

	// ---- meta ----

	async getMeta(key) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT value FROM jc_meta WHERE key = ?', [key]);
		return rows.length ? rows[0].getResultByIndex(0) : null;
	},

	async setMeta(key, value) {
		let conn = await this.open();
		await conn.execute('INSERT OR REPLACE INTO jc_meta (key, value) VALUES (?, ?)', [key, String(value)]);
	},

	normalizeKey(key) {
		return JCUtil.normalizeUrl(key);
	},
};
