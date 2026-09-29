/* global Zotero, Services, Cc, Ci, JournalCrawlerPlugin */
var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	let aomStartup = Cc['@mozilla.org/addons/addon-manager-startup;1']
		.getService(Ci.amIAddonManagerStartup);
	let manifestURI = Services.io.newURI(rootURI + 'manifest.json');
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		['content', 'journal-crawler', rootURI + 'content/'],
	]);
	Services.scriptloader.loadSubScript(rootURI + 'content/main.js');
	await JournalCrawlerPlugin.startup({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
	JournalCrawlerPlugin.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
	JournalCrawlerPlugin.onMainWindowUnload(window);
}

async function shutdown() {
	if (typeof JournalCrawlerPlugin !== 'undefined') {
		await JournalCrawlerPlugin.shutdown();
	}
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}

function uninstall() {}
