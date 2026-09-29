/* global JCAdapters, JCUtil */

/**
 * The Competition Law Review (CompLRev), published by the Competition Law Scholars Forum
 * (clasf.org, WordPress + WP-Filebase).
 *
 * "Browse the Review" is a WP-Filebase tree loaded by AJAX: a POST to /?wpfilebase_ajax=1
 * (wpfb_action=tree, type=browser, base=2, root=source) lists the issues ("Volume 16 - Issue 2",
 * newest first); with root=<category id> it lists the issue's files, each with the PDF link,
 * the title (<strong>), the authors (<em>) and the abstract (<p>).
 * The site has no dates: the year comes from the Last-Modified header of the issue's first PDF
 * (files uploaded one by one since mid-2016) or, for the issues migrated in bulk in March 2016,
 * from the table below (read from the issues' cover pages).
 */
var JCCompLRev = {
	base: 'http://clasf.org',
	/** volume-issue → year, for the issues uploaded in bulk when the site moved (2016-03) */
	years: {
		'1-1': 2004, '1-2': 2004, '2-1': 2005, '2-2': 2005, '3-1': 2006, '3-2': 2007, '4-1': 2007, '4-2': 2008,
		'5-1': 2008, '5-2': 2009, '6-1': 2009, '6-2': 2010, '7-1': 2010, '7-2': 2011, '8-1': 2011, '8-2': 2012,
		'8-3': 2012, '9-1': 2013, '9-2': 2013, '10-1': 2014, '10-2': 2014, '11-1': 2015, '11-2': 2016,
	},

	async tree(ctx, root) {
		let body = `wpfb_action=tree&type=browser&base=2&root=${encodeURIComponent(root)}`;
		let res = await ctx.request(this.base + '/?wpfilebase_ajax=1', {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
		});
		return res.json();
	},

	html(s) {
		return new DOMParser().parseFromString(`<!doctype html><html><body>${s || ''}</body></html>`, 'text/html');
	},
};

JCAdapters.register({
	id: 'the-competition-law-review',
	label: 'The Competition Law Review (clasf.org)',
	description: 'Issues and files from the WP-Filebase AJAX tree of "Browse the Review"; year from the PDF Last-Modified header or a table for the migrated issues.',
	params: {},

	async *discover(ctx) {
		let issues = [];
		for (let node of await JCCompLRev.tree(ctx, 'source')) {
			if (node.type !== 'cat') continue;
			let label = JCUtil.text(JCCompLRev.html(node.text).body);
			let m = /volume\s*(\d+)\D+issue\s*(\d+)/i.exec(label);
			if (m) issues.push({ id: node.cat_id, volume: m[1], issue: m[2], label });
		}
		issues.sort((a, b) => (b.volume - a.volume) || (b.issue - a.issue));
		for (let [i, iss] of issues.entries()) {
			if (ctx.cancelled) return;
			let key = `complrev:${iss.volume}-${iss.issue}`;
			let known = JCCompLRev.years[`${iss.volume}-${iss.issue}`];
			if (known && ctx.tooOld(String(known))) break;
			if (await ctx.isIssueDone(key)) continue;
			let files = (await JCCompLRev.tree(ctx, iss.id)).filter(f => f.type === 'file');
			let refs = [];
			for (let f of files) {
				let doc = JCCompLRev.html(f.text);
				let a = doc.querySelector('a[href]');
				let pdfUrl = a && JCUtil.absUrl(a.getAttribute('href'), JCCompLRev.base + '/');
				let title = JCUtil.text(doc.querySelector('strong') || a);
				if (!pdfUrl || !title) continue;
				let meta = { title: JCUtil.cleanTitle(title), volume: iss.volume, issue: iss.issue };
				let em = doc.querySelector('em');
				// the author line is the <em> right after the title, before the abstract
				if (em && !em.closest('p')) meta.creators = JCUtil.parseAuthors(JCUtil.text(em));
				let abs = doc.querySelector('p');
				if (abs) meta.abstractNote = JCUtil.text(abs);
				refs.push({ key: pdfUrl, pdfUrl, url: null, meta, issueKey: key });
			}
			if (!refs.length) continue;
			let year = known;
			if (!year) {
				// uploaded after the 2016 migration: the upload date is the publication date
				let res = await ctx.request(refs[0].pdfUrl, { method: 'HEAD', allowErrors: true });
				let lm = res.headers.get('last-modified');
				let d = lm ? new Date(lm) : null;
				if (d && !isNaN(d)) year = d.getUTCFullYear();
			}
			if (year && ctx.tooOld(String(year))) break;
			for (let ref of refs) {
				if (year) ref.meta.date = String(year);
				yield ref;
			}
			if (i > 0) ctx.markIssueDone(key);
		}
	},
});
