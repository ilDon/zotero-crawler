/* global Zotero, IOUtils, PathUtils, JCUtil, JCStore */
/* exported JCImporter */

/**
 * Creates Zotero items from resolved refs: duplicate check, collection per journal,
 * journalArticle with the metadata, PDF attachment.
 */
var JCImporter = {
	get libraryID() {
		return Zotero.Libraries.userLibraryID;
	},

	get rootCollectionName() {
		return JCStore.getSetting('collectionRoot') || 'Riviste';
	},

	// ---- collections ----

	async _findOrCreateCollection(name, parentID) {
		let siblings = parentID
			? Zotero.Collections.getByParent(parentID)
			: Zotero.Collections.getByLibrary(this.libraryID);
		let hit = siblings.find(c => c.name === name && !c.deleted);
		if (hit) return hit;
		let c = new Zotero.Collection();
		c.libraryID = this.libraryID;
		c.name = name;
		if (parentID) c.parentID = parentID;
		await c.saveTx();
		return c;
	},

	/** Journal name for collections and publicationTitle (as written in the journal list) */
	displayTitle(journal) {
		return journal.title || journal.slug;
	},

	/** Collection of a journal: the one chosen by the user, else <root>/<journal title> */
	async collectionFor(journal) {
		if (journal.collectionKey) {
			let c = Zotero.Collections.getByLibraryAndKey(this.libraryID, journal.collectionKey);
			if (c && !c.deleted) return c;
		}
		// one at a time: journals run in parallel and must not create the root collection twice
		let run = async () => {
			let root = await this._findOrCreateCollection(this.rootCollectionName, null);
			return this._findOrCreateCollection(this.displayTitle(journal), root.id);
		};
		let p = (this._collectionLock || Promise.resolve()).then(run, run);
		this._collectionLock = p.catch(() => {});
		return p;
	},

	// ---- duplicates ----

	async _search(conditions) {
		let s = new Zotero.Search();
		s.libraryID = this.libraryID;
		for (let [c, op, v] of conditions) s.addCondition(c, op, v);
		s.addCondition('deleted', 'false');
		let ids = await s.search();
		return Zotero.Items.get(ids).filter(i => i.isRegularItem());
	},

	/**
	 * An item of the library that is the same article: same DOI, same URL, or same title
	 * (normalized) and year.
	 */
	async findDuplicate(ref) {
		let meta = ref.meta || {};
		if (meta.DOI) {
			let hits = await this._search([['DOI', 'is', meta.DOI]]);
			if (hits.length) return hits[0];
		}
		for (let u of [ref.url, ref.pdfUsed].filter(Boolean)) {
			let hits = await this._search([['url', 'is', u]]);
			if (hits.length) return hits[0];
		}
		let norm = JCUtil.normTitle(meta.title);
		if (norm.length >= 12) {
			// search on the longest word run without punctuation, then compare normalized titles
			let words = JCUtil.text(meta.title).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
			let probe = words.slice(0, 6).join(' ');
			let candidates = await this._search([['title', 'contains', words.sort((a, b) => b.length - a.length)[0] || probe]]);
			let year = JCUtil.yearOf(meta.date);
			for (let item of candidates) {
				if (JCUtil.normTitle(item.getField('title')) !== norm) continue;
				let y = JCUtil.yearOf(item.getField('date'));
				if (!year || !y || Math.abs(year - y) <= 1) return item;
			}
		}
		return null;
	},

	hasPdf(item) {
		return item.getAttachments().some((id) => {
			let a = Zotero.Items.get(id);
			return a && a.isPDFAttachment && a.isPDFAttachment();
		});
	},

	// ---- items ----

	_setField(item, field, value) {
		if (value == null || value === '') return;
		let fieldID = Zotero.ItemFields.getID(field);
		if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) return;
		try {
			item.setField(field, String(value).slice(0, 10000));
		}
		catch (e) {
			Zotero.debug(`Journal Crawler: cannot set ${field}: ${e}`);
		}
	},

	async createItem(ref, journal, collection) {
		let meta = ref.meta || {};
		let itemType = meta.itemType && Zotero.ItemTypes.getID(meta.itemType) ? meta.itemType : 'journalArticle';
		let item = new Zotero.Item(itemType);
		item.libraryID = this.libraryID;
		this._setField(item, 'title', meta.title);
		this._setField(item, 'publicationTitle', meta.publicationTitle || this.displayTitle(journal));
		this._setField(item, 'date', meta.date);
		this._setField(item, 'volume', meta.volume);
		this._setField(item, 'issue', meta.issue);
		this._setField(item, 'pages', meta.pages);
		this._setField(item, 'DOI', meta.DOI);
		this._setField(item, 'ISSN', meta.ISSN || (journal.params && journal.params.issn));
		this._setField(item, 'language', meta.language);
		this._setField(item, 'abstractNote', meta.abstractNote);
		this._setField(item, 'url', ref.url || ref.pdfUsed || ref.pdfUrl);
		this._setField(item, 'accessDate', Zotero.Date.dateToSQL(new Date(), true));
		this._setField(item, 'libraryCatalog', this.displayTitle(journal));
		if (meta.extra) this._setField(item, 'extra', meta.extra);
		let creators = (meta.creators || []).filter(c => c && (c.lastName || c.name)).map((c) => {
			let out = { creatorType: c.creatorType || 'author' };
			if (c.name || c.fieldMode === 1 || !c.firstName) {
				out.lastName = c.name || c.lastName;
				out.fieldMode = 1;
			}
			else {
				out.firstName = c.firstName;
				out.lastName = c.lastName;
			}
			return out;
		});
		if (creators.length) item.setCreators(creators);
		let tag = JCStore.getSetting('tag');
		if (tag) item.addTag(tag, 1);
		if (collection) item.addToCollection(collection.id);
		await item.saveTx();
		return item;
	},

	async addToCollection(item, collection) {
		if (collection && !item.inCollection(collection.id)) {
			item.addToCollection(collection.id);
			await item.saveTx();
		}
	},

	/** Attach PDF bytes as a stored file named after the parent item (Zotero's rename format) */
	async attachPdf(item, bytes, url) {
		let base = 'article';
		try {
			base = Zotero.Attachments.getFileBaseNameFromItem(item) || base;
		}
		catch (e) {}
		let filename = Zotero.File.getValidFileName(base).slice(0, 150) + '.pdf';
		let dir = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
		let path = PathUtils.join(dir, filename);
		await IOUtils.write(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
		try {
			return await Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory({
				directory: dir,
				libraryID: item.libraryID,
				parentItemID: item.id,
				title: 'Full Text PDF',
				filename,
				url,
				contentType: 'application/pdf',
			});
		}
		catch (e) {
			// older Zotero versions: plain file import
			let att = await Zotero.Attachments.importFromFile({
				file: path,
				libraryID: item.libraryID,
				parentItemID: item.id,
				title: 'PDF',
				contentType: 'application/pdf',
			});
			await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
			return att;
		}
	},
};
