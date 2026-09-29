// Writes the index of the adapters shipped with the plugin and packages addon/ into
// build/zotero-journal-crawler-<version>.xpi
// Usage: node scripts/build.mjs [--index-only] [--dev] [--version X.Y.Z]
//   --dev  include content/dev.js (scripted test runs, see scripts/zotero-test.sh)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const addon = join(root, 'addon');
const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i === -1 ? null : process.argv[i + 1];
};

// ---- adapter index: generic adapters first, site adapters may build on them ----
const adapterDir = join(addon, 'content/lib/adapters');
// generic adapters first: platform adapters may build on them
const order = ['oai.js', 'ojs.js', 'wordpress.js', 'crawl.js', 'crossref.js'];
const files = readdirSync(adapterDir).filter(f => f.endsWith('.js'))
	.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
writeFileSync(join(adapterDir, 'index.json'), JSON.stringify({ files }, null, '\t') + '\n');
if (process.argv.includes('--index-only')) process.exit(0);

// ---- xpi ----
const manifest = JSON.parse(readFileSync(join(addon, 'manifest.json'), 'utf8'));
const version = arg('--version') || manifest.version;
const dev = process.argv.includes('--dev');
const build = join(root, 'build');
const stage = join(build, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
cpSync(addon, stage, { recursive: true, filter: src => !/(^|\/)\.[^/]+$/.test(src) && (dev || !src.endsWith('/content/dev.js')) });
manifest.version = version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
// versioned stylesheet and script URLs: Zotero keeps chrome files cached across plugin updates
for (const f of readdirSync(join(stage, 'content/ui')).filter(f => f.endsWith('.xhtml'))) {
	const p = join(stage, 'content/ui', f);
	writeFileSync(p, readFileSync(p, 'utf8').replaceAll('__VERSION__', encodeURIComponent(version + (dev ? '-dev' + Date.now() : ''))));
}
const out = join(build, `zotero-journal-crawler-${version}${dev ? '-dev' : ''}.xpi`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(out);
