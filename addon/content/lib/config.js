/* global JCStore, JCAdapters, JCDetect */
/* exported JCConfig */

/**
 * Import and export of the journal list as a JSON file:
 *
 *   {
 *     "format": "zotero-journal-crawler",
 *     "version": 1,
 *     "journals": [{ "slug", "title", "url", "adapter", "params", "enabled", "sinceYear",
 *                    "notes", "instructions", "survey" }, …]
 *   }
 */
var JCConfig = {
	FORMAT: 'zotero-journal-crawler',
	VERSION: 1,

	/** Parse and check a configuration file's text; throws with a readable message */
	parse(text) {
		let obj;
		try {
			obj = JSON.parse(text);
		}
		catch (e) {
			throw new Error('JSON non valido: ' + e.message);
		}
		if (Array.isArray(obj)) obj = { journals: obj };
		if (!obj || !Array.isArray(obj.journals)) throw new Error('Il file non contiene un elenco "journals"');
		if (obj.format && obj.format !== this.FORMAT) throw new Error(`Formato sconosciuto: ${obj.format}`);
		let journals = obj.journals.map((j, i) => {
			for (let k of ['title', 'adapter']) {
				if (!j || !j[k]) throw new Error(`Rivista n. ${i + 1}: manca "${k}"`);
			}
			j = { ...j };
			if (!j.slug) j.slug = JCDetect.slugify(j.title);
			if (!/^[a-z0-9][a-z0-9-]*$/.test(j.slug)) throw new Error(`Identificativo non valido: ${j.slug}`);
			return j;
		});
		return { journals };
	},

	/**
	 * Add or update the journals (matched by slug).
	 * @returns {Promise<{added, updated, missingAdapters}>}
	 */
	async import(config) {
		let added = 0, updated = 0;
		for (let j of config.journals) {
			let existing = await JCStore.getJournalBySlug(j.slug);
			let entry = {
				slug: j.slug,
				title: j.title,
				url: j.url || '',
				adapter: j.adapter,
				params: j.params || {},
				enabled: j.enabled !== false,
				sinceYear: j.sinceYear || null,
				notes: j.notes || '',
				instructions: j.instructions || '',
				survey: j.survey || null,
			};
			if (existing) {
				let changed = existing.adapter !== entry.adapter || JSON.stringify(existing.params) !== JSON.stringify(entry.params);
				await JCStore.saveJournal({ ...existing, ...entry, id: existing.id, collectionKey: existing.collectionKey });
				// the cursors of another configuration are meaningless
				if (changed) await JCStore.setJournalFields(existing.id, { state: {} });
				updated++;
			}
			else {
				await JCStore.saveJournal(entry);
				added++;
			}
		}
		let missingAdapters = [...new Set(config.journals.map(j => j.adapter))].filter(id => !JCAdapters.get(id));
		return { added, updated, missingAdapters };
	},

	/** The whole configuration, or some journals */
	async export(journalIds = null) {
		let journals = (await JCStore.listJournals()).filter(j => !journalIds || journalIds.includes(j.id));
		return {
			format: this.FORMAT,
			version: this.VERSION,
			exported: new Date().toISOString(),
			journals: journals.map(j => ({
				slug: j.slug,
				title: j.title,
				url: j.url,
				adapter: j.adapter,
				params: j.params,
				enabled: j.enabled,
				...(j.sinceYear ? { sinceYear: j.sinceYear } : {}),
				notes: j.notes,
				...(j.instructions ? { instructions: j.instructions } : {}),
				...(j.survey ? { survey: j.survey } : {}),
			})),
		};
	},
};
