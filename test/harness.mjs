// Runs a site adapter outside Zotero, to develop and check adapters.
//
//   node test/harness.mjs --config <file.json|dir> <slug> [--limit 10] [--resolve 3] [--pdf 2] [--since 2024] [--json]
//   node test/harness.mjs --adapter ojs --params '{"base":"https://…"}' …
//   node test/harness.mjs --config <file.json|dir> --all [--limit 3 --resolve 1 --pdf 1]   (smoke test)
//
//   --config     the journal list: a file exported by the plugin ("Esporta JSON"), or a directory
//                with journals/<slug>.json and adapters/<id>.js (see scripts/config.mjs);
//                default: the JC_CONFIG environment variable
//   --limit N    stop after N refs (default 10)
//   --resolve N  complete the first N refs as the plugin does (landing page metadata)
//   --pdf N      download the PDF of the first N resolved refs and check it is a PDF
//   --since Y    first year (default: none)
//   --state F    JSON file with {seen: [keys], issuesDone: [keys], state: {}}; updated at the end
//   --json       print refs as JSON
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML, DOMParser } from 'linkedom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(root, 'addon/content/lib');

// ---- load the plugin's shared code into this realm ----
globalThis.DOMParser = DOMParser;
/** Journals and site adapters of a configuration (JSON file or directory) */
export function loadConfig(path) {
	if (!path) return { journals: [], adapters: {} };
	if (statSync(path).isDirectory()) {
		let dir = (d) => existsSync(join(path, d)) ? readdirSync(join(path, d)).sort() : [];
		return {
			journals: dir('journals').filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(path, 'journals', f), 'utf8'))),
			adapters: Object.fromEntries(dir('adapters').filter(f => f.endsWith('.js')).map(f => [f.slice(0, -3), readFileSync(join(path, 'adapters', f), 'utf8')])),
		};
	}
	let obj = JSON.parse(readFileSync(path, 'utf8'));
	return { journals: obj.journals || [], adapters: obj.adapters || {} };
}

export function loadAdapters(adapters) {
	for (let [id, code] of Object.entries(adapters)) vm.runInThisContext(code, { filename: `config/adapters/${id}.js` });
}

export function loadLib() {
	if (globalThis.JCAdapters) return;
	for (let f of ['util.js', 'adapters.js', 'resolver.js']) {
		vm.runInThisContext(readFileSync(join(lib, f), 'utf8').replace(/^if \(typeof module.*$/m, ''), { filename: f });
	}
	let dir = join(lib, 'adapters');
	// generic adapters first: specific ones may build on them
	let files = readdirSync(dir).filter(f => f.endsWith('.js'));
	let order = ['oai.js', 'ojs.js', 'wordpress.js', 'crawl.js', 'crossref.js'];
	files.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
	for (let f of files) vm.runInThisContext(readFileSync(join(dir, f), 'utf8'), { filename: 'adapters/' + f });
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';

export function makeContext(journal, opts = {}) {
	const lastHit = new Map();
	const cookies = new Map();
	const seen = new Set(opts.seen || []);
	const issuesDone = new Set(opts.issuesDone || []);
	const pendingIssues = new Set();
	const delay = journal.params?.delayMs ?? 800;
	const log = opts.quiet ? () => {} : (...a) => console.error('  ·', ...a);

	async function request(url, o = {}) {
		let host = new URL(url).host;
		let wait = (lastHit.get(host) || 0) + delay - Date.now();
		if (wait > 0) await new Promise(r => setTimeout(r, wait));
		lastHit.set(host, Date.now());
		let headers = { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', Accept: '*/*', ...(o.headers || {}) };
		if (cookies.get(host)) headers.Cookie = cookies.get(host);
		let res, err;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				res = await fetch(url, { method: o.method || 'GET', headers, body: o.body, redirect: 'follow', signal: AbortSignal.timeout(60000) });
				if (res.status >= 500 || res.status === 429) {
					err = new Error(`HTTP ${res.status} ${url}`);
					await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
					continue;
				}
				break;
			}
			catch (e) {
				err = e;
				await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
			}
		}
		if (!res) throw err;
		let sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
		if (sc.length) {
			let jar = new Map((cookies.get(host) || '').split('; ').filter(Boolean).map(c => c.split(/=(.*)/s).slice(0, 2)));
			for (let c of sc) {
				let [kv] = c.split(';');
				let [k, v] = kv.split(/=(.*)/s);
				jar.set(k.trim(), v);
			}
			cookies.set(host, [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
		}
		if (!res.ok && !o.allowErrors) throw new Error(`HTTP ${res.status} ${url}`);
		let bytes = new Uint8Array(await res.arrayBuffer());
		let contentType = res.headers.get('content-type') || '';
		let finalUrl = res.url || url;
		let text = null;
		return {
			status: res.status,
			url: finalUrl,
			contentType,
			headers: res.headers,
			bytes,
			get text() {
				if (text === null) text = JCUtil.decode(bytes, contentType);
				return text;
			},
			json() {
				return JSON.parse(this.text);
			},
			doc() {
				let { document } = parseHTML(this.text);
				document.__url = finalUrl;
				return document;
			},
		};
	}

	const ctx = {
		journal,
		params: journal.params || {},
		state: opts.state || {},
		since: opts.since || null,
		util: JCUtil,
		cancelled: false,
		tooOld(date) {
			let y = JCUtil.yearOf(date);
			return !!(ctx.since && y && y < ctx.since);
		},
		request,
		async getText(url, o) {
			return (await request(url, o)).text;
		},
		async getJSON(url, o) {
			return (await request(url, o)).json();
		},
		async getDoc(url, o) {
			return (await request(url, o)).doc();
		},
		async getXML(url, o) {
			let r = await request(url, o);
			let doc = new DOMParser().parseFromString(JCUtil.cleanXml(r.text), 'text/xml');
			if (doc.querySelector('parsererror')) throw new Error(`Invalid XML from ${r.url}`);
			doc.__url = r.url;
			return doc;
		},
		async isSeen(key) {
			return seen.has(JCUtil.normalizeUrl(key));
		},
		async isIssueDone(key) {
			return issuesDone.has(key);
		},
		markIssueDone(key) {
			pendingIssues.add(key);
			log('issue done:', key);
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
		log,
		warn: (...a) => console.error('  !', ...a),
		_pendingIssues: pendingIssues,
		_seen: seen,
		_issuesDone: issuesDone,
	};
	return ctx;
}

function fmtCreators(cs) {
	return (cs || []).map(c => c.name || [c.lastName, c.firstName].filter(Boolean).join(', ')).join('; ');
}

export async function runJournal(journal, opts) {
	let adapter = JCAdapters.get(journal.adapter);
	if (!adapter) throw new Error(`No adapter "${journal.adapter}"`);
	let stateFile = opts.stateFile;
	let saved = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
	let ctx = makeContext(journal, { ...opts, seen: saved.seen, issuesDone: saved.issuesDone, state: saved.state });
	let refs = [];
	let t0 = Date.now();
	for await (let ref of adapter.discover(ctx)) {
		if (await ctx.isSeen(ref.key || ref.url || ref.pdfUrl)) continue;
		refs.push(ref);
		if (refs.length >= opts.limit) break;
	}
	let out = { slug: journal.slug, found: refs.length, resolved: 0, pdfOk: 0, pdfFail: 0, errors: [], seconds: 0 };
	for (let [i, ref] of refs.entries()) {
		if (i < opts.resolve) {
			try {
				await JCResolver.resolve(ctx, adapter, ref);
				out.resolved++;
			}
			catch (e) {
				out.errors.push(`resolve ${ref.url}: ${e.message}`);
			}
		}
		if (i < opts.pdf && ref.pdfCandidates) {
			let pdf = await JCResolver.fetchPdf(ctx, ref.pdfCandidates, ref.url);
			ref.pdfCheck = pdf ? `OK ${Math.round(pdf.bytes.length / 1024)} KB ${pdf.url}` : 'NO PDF';
			pdf ? out.pdfOk++ : out.pdfFail++;
		}
	}
	out.seconds = Math.round((Date.now() - t0) / 1000);
	if (opts.json) {
		console.log(JSON.stringify(refs, null, 1));
	}
	else if (!opts.quiet) {
		for (let r of refs) {
			let m = r.meta || {};
			console.log(`- ${m.date || '????'} | ${m.title || '(no title)'}`);
			console.log(`    ${fmtCreators(m.creators) || '(no authors)'}${m.volume ? ' | vol ' + m.volume : ''}${m.issue ? ' n. ' + m.issue : ''}${m.pages ? ' pp. ' + m.pages : ''}${m.DOI ? ' | ' + m.DOI : ''}`);
			console.log(`    key: ${r.key || r.url || r.pdfUrl}`);
			if (r.url) console.log(`    url: ${r.url}`);
			let p = r.pdfCandidates || [r.pdfUrl, ...(r.pdfUrls || [])].filter(Boolean);
			if (p.length) console.log(`    pdf: ${p.join(' , ')}`);
			if (r.pdfCheck) console.log(`    check: ${r.pdfCheck}`);
		}
		console.error(`\n${journal.slug}: ${refs.length} refs in ${out.seconds}s; state=${JSON.stringify(ctx.state)}`);
	}
	if (stateFile) {
		let seen = [...ctx._seen, ...refs.map(r => JCUtil.normalizeUrl(r.key || r.url || r.pdfUrl))];
		writeFileSync(stateFile, JSON.stringify({ seen, issuesDone: [...ctx._issuesDone, ...ctx._pendingIssues], state: ctx.state }, null, 1));
	}
	return out;
}

function arg(name, def) {
	let i = process.argv.indexOf(name);
	return i === -1 ? def : process.argv[i + 1];
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	loadLib();
	let config = loadConfig(arg('--config', process.env.JC_CONFIG));
	loadAdapters(config.adapters);
	let journals = config.journals;
	let opts = {
		limit: +arg('--limit', 10),
		resolve: +arg('--resolve', 0),
		pdf: +arg('--pdf', 0),
		since: arg('--since') ? +arg('--since') : null,
		json: process.argv.includes('--json'),
		stateFile: arg('--state'),
	};
	if (process.argv.includes('--all')) {
		opts.quiet = true;
		let only = arg('--adapter');
		for (let j of journals.filter(j => j.enabled !== false && (!only || j.adapter === only))) {
			try {
				let r = await runJournal(j, opts);
				let ok = r.found && (!opts.pdf || r.pdfOk || j.params.htmlToPdf);
				console.log(`${ok ? 'OK  ' : 'FAIL'} ${j.slug.padEnd(28)} ${j.adapter.padEnd(12)} found=${r.found} pdf=${r.pdfOk}/${r.pdfOk + r.pdfFail} ${r.seconds}s ${r.errors.join(' | ')}`);
			}
			catch (e) {
				console.log(`FAIL ${j.slug.padEnd(28)} ${j.adapter.padEnd(12)} ${e.message}`);
			}
		}
	}
	else {
		let journal;
		if (arg('--adapter')) {
			journal = { slug: 'adhoc', title: 'adhoc', adapter: arg('--adapter'), params: JSON.parse(arg('--params', '{}')) };
		}
		else {
			let slug = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
			journal = journals.find(j => j.slug === slug);
			if (!journal) {
				console.error(`Unknown journal "${slug}". Slugs: ${journals.map(j => j.slug).join(' ')}`);
				process.exit(1);
			}
		}
		await runJournal(journal, opts);
	}
}
