/* global Zotero, ChromeUtils, Cc, Ci, IOUtils */
/* exported JCHtmlPdf */

/**
 * Renders a web page to PDF with Gecko's print engine (silent print to file) in a hidden
 * browser: articles published only as HTML are attached as PDF like all the others.
 */
var JCHtmlPdf = {
	TIMEOUT_MS: 60000,

	_settings(path) {
		let svc = Cc['@mozilla.org/gfx/printsettings-service;1'].getService(Ci.nsIPrintSettingsService);
		let s = svc.createNewPrintSettings();
		// the same virtual printer as Firefox's "Save to PDF"
		s.printerName = 'Mozilla Save to PDF';
		s.printSilent = true;
		s.outputDestination = Ci.nsIPrintSettings.kOutputDestinationFile;
		s.outputFormat = Ci.nsIPrintSettings.kOutputFormatPDF;
		s.toFileName = path;
		s.printBGColors = false;
		s.printBGImages = false;
		s.shrinkToFit = true;
		s.scaling = 1;
		// A4
		s.paperId = 'iso_a4';
		s.paperWidth = 210;
		s.paperHeight = 297;
		s.paperSizeUnit = Ci.nsIPrintSettings.kPaperSizeMillimeters;
		for (let k of ['headerStrLeft', 'headerStrCenter', 'headerStrRight', 'footerStrCenter']) s[k] = '';
		// the URL and the page number in the footer, as a browser's "Save as PDF"
		s.footerStrLeft = '&U';
		s.footerStrRight = '&PT';
		return s;
	},

	/**
	 * @param {String} url
	 * @param {String} path - PDF file to write
	 * @param {Object} [opts] - {customUserAgent, settleMs}
	 * @returns {Promise<void>}
	 */
	async render(url, path, opts = {}) {
		const { HiddenBrowser } = ChromeUtils.importESModule('chrome://zotero/content/HiddenBrowser.mjs');
		// printing needs a browser attached to a real window (as Zotero's own print feature)
		let browser = new HiddenBrowser({ customUserAgent: opts.customUserAgent, useHiddenFrame: false });
		try {
			await browser._createdPromise;
			await browser.load(url, { requireSuccessfulStatus: true });
			// wait for the page (and bot checks) to settle
			await Zotero.Promise.delay(opts.settleMs || 2500);
			let print = browser.browsingContext.print(this._settings(path));
			await Promise.race([
				print,
				Zotero.Promise.delay(this.TIMEOUT_MS).then(() => {
					throw new Error('PDF rendering timed out');
				}),
			]);
			// the file is written asynchronously after the promise on some platforms
			for (let i = 0; i < 20; i++) {
				if (await IOUtils.exists(path) && (await IOUtils.stat(path)).size > 0) break;
				await Zotero.Promise.delay(250);
			}
		}
		finally {
			browser.destroy();
		}
	},
};
