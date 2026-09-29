/* global Zotero, Services, JCDev, JCUtil, JCAdapters, JCResolver, JCStore, JCImporter, JCRunner, JCEvents, JCDetect, JCConfig */

var JournalCrawlerPlugin = {
	WINDOW_URL: 'chrome://journal-crawler/content/ui/crawler.xhtml',
	WINDOW_TYPE: 'zotero:journal-crawler',
	ICON: 'chrome://journal-crawler/content/icons/crawler.svg',
	FTL: 'journal-crawler.ftl',
	_menuIDs: [],

	async startup({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		for (let f of ['util', 'adapters', 'resolver', 'store', 'importer', 'runner', 'detect', 'htmlpdf', 'config']) {
			Services.scriptloader.loadSubScript(rootURI + `content/lib/${f}.js`);
		}
		// platform adapters shipped with the plugin (list written by the build)
		let index = JSON.parse(Zotero.File.getContentsFromURL('chrome://journal-crawler/content/lib/adapters/index.json'));
		for (let f of index.files) {
			try {
				Services.scriptloader.loadSubScript(rootURI + 'content/lib/adapters/' + f);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		// Public API for the window (it runs in its own global)
		Zotero.JournalCrawler = {
			plugin: this,
			util: JCUtil,
			adapters: JCAdapters,
			resolver: JCResolver,
			store: JCStore,
			importer: JCImporter,
			runner: JCRunner,
			events: JCEvents,
			detect: JCDetect,
			config: JCConfig,
		};

		try {
			await JCStore.open();
		}
		catch (e) {
			Zotero.logError(e);
		}
		this._registerMenus();
		for (let win of Zotero.getMainWindows()) this.onMainWindowLoad(win);
		Zotero.debug('Journal Crawler: started ' + version);

		// development: scripted runs in a throwaway profile (content/dev.js is not packaged)
		let dev = Zotero.Prefs.get('extensions.journal-crawler.devAutorun', true);
		if (dev) {
			Services.scriptloader.loadSubScript(rootURI + 'content/dev.js');
			JCDev.autorun(JSON.parse(dev)).catch(e => Zotero.logError(e));
		}
	},

	get isItalian() {
		return String(Zotero.locale || '').startsWith('it');
	},

	_registerMenus() {
		let id = Zotero.MenuManager.registerMenu({
			menuID: 'jcrawler-tools',
			pluginID: this.id,
			target: 'main/menubar/tools',
			menus: [{
				menuType: 'menuitem',
				l10nID: 'jcrawler-menuitem-open',
				icon: this.ICON,
				onCommand: () => this.openWindow(),
			}],
		});
		if (id) this._menuIDs.push(id);
	},

	onMainWindowLoad(win) {
		win.MozXULElement.insertFTLIfNeeded(this.FTL);
		this._addToolbarButton(win.document);
	},

	/** Button in the items toolbar, before the search box (and other plugins' buttons there) */
	_addToolbarButton(doc) {
		if (doc.getElementById('jcrawler-tb-button')) return;
		let search = doc.getElementById('zotero-tb-search');
		if (!search || !search.parentElement) return;
		let button = doc.createXULElement('toolbarbutton');
		button.id = 'jcrawler-tb-button';
		button.className = 'zotero-tb-button';
		button.setAttribute('tabindex', '-1');
		button.setAttribute('tooltiptext', this.isItalian ? 'Riviste: scarica articoli' : 'Journals: download articles');
		button.style.listStyleImage = `url("${this.ICON}")`;
		// same tint as Zotero's own toolbar icons (light and dark mode)
		button.style.fill = 'var(--fill-secondary)';
		button.style.setProperty('-moz-context-properties', 'fill, fill-opacity');
		button.addEventListener('command', () => this.openWindow());
		let before = search;
		if (before.previousElementSibling && before.previousElementSibling.id === 'zotero-tb-search-spinner') {
			before = before.previousElementSibling;
		}
		search.parentElement.insertBefore(button, before);
	},

	onMainWindowUnload(win) {
		let doc = win.document;
		let button = doc.getElementById('jcrawler-tb-button');
		if (button) button.remove();
		let link = doc.querySelector(`link[href="${this.FTL}"]`);
		if (link) link.remove();
	},

	openWindow() {
		let existing = Services.wm.getMostRecentWindow(this.WINDOW_TYPE);
		if (existing) {
			existing.focus();
			return existing;
		}
		// versioned URL: Zotero keeps chrome files cached across plugin updates
		let url = this.WINDOW_URL + '?v=' + encodeURIComponent(this.version);
		return Zotero.getMainWindow().openDialog(url, '', 'chrome,resizable,centerscreen,dialog=no');
	},

	async shutdown() {
		try {
			JCRunner.stop();
			for (let id of this._menuIDs) Zotero.MenuManager.unregisterMenu(id);
			this._menuIDs = [];
			for (let win of Zotero.getMainWindows()) this.onMainWindowUnload(win);
			let enumerator = Services.wm.getEnumerator(this.WINDOW_TYPE);
			while (enumerator.hasMoreElements()) enumerator.getNext().close();
			await JCStore.close();
		}
		catch (e) {
			Zotero.logError(e);
		}
		delete Zotero.JournalCrawler;
	},
};
