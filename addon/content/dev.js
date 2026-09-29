/* global Zotero, JCHtmlPdf, JCConfig, Services, Ci, IOUtils, JCStore, JCRunner, JournalCrawlerPlugin */
/* exported JCDev */

/**
 * Development only (not packaged): when the pref extensions.journal-crawler.devAutorun holds
 * {"importFile": "/path/journals.json", "slugs": [...], "dryRun": false, "since": 2025,
 *  "out": "/path/result.json", "screenshot": "/path/window.png", "quit": true},
 * runs those journals after startup and writes what ended up in the library to "out".
 * Used by scripts/zotero-test.sh with a throwaway profile and data directory.
 */
var JCDev = {
	/** PNG of the plugin window (optionally with a journal selected), without touching the screen */
	async screenshot(cfg) {
		let win = Services.wm.getMostRecentWindow(JournalCrawlerPlugin.WINDOW_TYPE) || JournalCrawlerPlugin.openWindow();
		await Zotero.Promise.delay(3000);
		if (cfg.selectSlug && win.JCWindow) {
			let j = win.JCWindow.journals.find(x => x.slug === cfg.selectSlug);
			if (j) win.JCWindow.select(j.id);
			if (cfg.selectSlugs) {
				win.JCWindow.selected = new Set(win.JCWindow.journals.filter(x => cfg.selectSlugs.includes(x.slug)).map(x => x.id));
				win.JCWindow.renderList();
			}
			await Zotero.Promise.delay(1500);
		}
		if (cfg.screenshotMain) win = Zotero.getMainWindow();
		let bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, 'white');
		let canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext('2d').drawImage(bitmap, 0, 0);
		let data = canvas.toDataURL('image/png').split(',')[1];
		await IOUtils.write(cfg.screenshot, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
	},

	async autorun(cfg) {
		await Zotero.Promise.delay(cfg.delay || 3000);
		let out = { started: new Date().toISOString() };
		if (cfg.printTest) {
			try {
				let t = Date.now();
				await JCHtmlPdf.render(cfg.printTest.url, cfg.printTest.path);
				let st = await IOUtils.stat(cfg.printTest.path);
				out.printTest = { ok: true, size: st.size, ms: Date.now() - t };
			}
			catch (e) {
				out.printTest = { ok: false, error: `${e && e.message} ${e && e.stack}` };
			}
		}
		try {
			if (cfg.importFile) {
				out.import = await JCConfig.import(JCConfig.parse(await IOUtils.readUTF8(cfg.importFile)));
			}
			if (cfg.since !== undefined) await JCStore.setSetting('defaultSinceYear', cfg.since);
			if (cfg.limitPerJournal) Zotero.Prefs.set('extensions.journal-crawler.devLimit', cfg.limitPerJournal, true);
			if (cfg.openWindow) JournalCrawlerPlugin.openWindow();
			let all = await JCStore.listJournals();
			let ids = all.filter(j => !cfg.slugs || cfg.slugs.includes(j.slug)).map(j => j.id);
			out.journalCount = all.length;
			for (let pass = 1; pass <= (cfg.passes || 1); pass++) {
				out['totals' + pass] = await JCRunner.run({ journalIds: ids, dryRun: !!cfg.dryRun });
			}
			out.journals = [];
			for (let j of (await JCStore.listJournals()).filter(j => ids.includes(j.id))) {
				let arts = await JCStore.listArticles(j.id, { limit: 50 });
				out.journals.push({
					slug: j.slug,
					counts: j.counts,
					lastError: j.lastError,
					state: j.state,
					articles: arts.map((a) => {
						let r = { status: a.status, title: a.title, date: a.date, error: a.error };
						let item = a.itemKey && Zotero.Items.getByLibraryAndKey(a.libraryID, a.itemKey);
						if (item) {
							r.item = {
								title: item.getField('title'),
								date: item.getField('date'),
								publicationTitle: item.getField('publicationTitle'),
								volume: item.getField('volume'),
								issue: item.getField('issue'),
								DOI: item.getField('DOI'),
								url: item.getField('url'),
								creators: item.getCreators().map(c => [c.lastName, c.firstName].filter(Boolean).join(', ')),
								collections: item.getCollections().map(id => Zotero.Collections.get(id).name),
								attachments: item.getAttachments().map((id) => {
									let att = Zotero.Items.get(id);
									return { contentType: att.attachmentContentType, filename: att.attachmentFilename, url: att.getField('url') };
								}),
							};
						}
						return r;
					}),
				});
			}
		}
		catch (e) {
			out.error = String(e && e.stack || e);
		}
		out.collections = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true)
			.map(c => (c.parentID ? Zotero.Collections.get(c.parentID).name + ' / ' : '') + c.name);
		out.settings = Object.fromEntries(Object.keys(JCStore.SETTINGS).map(k => [k, JCStore.getSetting(k)]));
		out.log = JCRunner.log.map(l => l.line);
		if (cfg.screenshot) {
			try {
				await this.screenshot(cfg);
			}
			catch (e) {
				out.screenshotError = String(e);
			}
		}
		out.finished = new Date().toISOString();
		await IOUtils.writeUTF8(cfg.out, JSON.stringify(out, null, 1));
		if (cfg.quit) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
	},
};
