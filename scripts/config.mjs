// Packs a journal configuration kept as a directory into the JSON file the plugin imports
// ("Importa JSON…"), or unpacks such a file into a directory:
//   <dir>/journals/<slug>.json   one journal: slug, title, url, adapter, params, enabled, notes, …
//
//   node scripts/config.mjs pack <dir> <out.json>
//   node scripts/config.mjs unpack <in.json> <dir>
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, from, to] = process.argv.slice(2);
if (!['pack', 'unpack'].includes(cmd) || !from || !to) {
	console.error('Usage: node scripts/config.mjs pack <dir> <out.json> | unpack <in.json> <dir>');
	process.exit(1);
}

if (cmd === 'pack') {
	const list = d => (existsSync(join(from, d)) ? readdirSync(join(from, d)).sort() : []);
	const journals = list('journals').filter(f => f.endsWith('.json'))
		.map(f => JSON.parse(readFileSync(join(from, 'journals', f), 'utf8')))
		.sort((a, b) => a.title.localeCompare(b.title));
	for (const j of journals) {
		if (!j.slug || !j.title || !j.adapter) throw new Error(`incomplete journal ${JSON.stringify(j).slice(0, 80)}`);
	}
	const out = { format: 'zotero-journal-crawler', version: 1, exported: new Date().toISOString(), journals };
	writeFileSync(to, JSON.stringify(out, null, 2) + '\n');
	console.log(`${to}: ${journals.length} journals (${journals.filter(j => j.enabled !== false).length} enabled)`);
}
else {
	const obj = JSON.parse(readFileSync(from, 'utf8'));
	mkdirSync(join(to, 'journals'), { recursive: true });
	for (const j of obj.journals || []) writeFileSync(join(to, 'journals', j.slug + '.json'), JSON.stringify(j, null, 2) + '\n');
	console.log(`${to}: ${(obj.journals || []).length} journals`);
}
