#!/bin/bash
# Runs the plugin in a separate Zotero instance with a throwaway profile and data directory
# (the real library is never touched), executes the given journals and writes the result JSON.
#   scripts/zotero-test.sh '<devAutorun JSON without "out">' [workdir]
# e.g. scripts/zotero-test.sh '{"importFile":"/path/journals.json","slugs":["some-journal"],"since":2025,"limitPerJournal":3,"quit":true}'
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${2:-/tmp/jc-zotero-test}"
CFG="$1"
mkdir -p "$WORK/profile/extensions" "$WORK/data"
# a proxy file pointing to addon/ is ignored by Zotero 10: install a dev build instead
XPI=$(node "$ROOT/scripts/build.mjs" --dev | tail -1)
cp "$XPI" "$WORK/profile/extensions/journal-crawler@ildon.github.io.xpi"
rm -f "$WORK/profile/addonStartup.json.lz4" "$WORK/profile/extensions.json"
OUT="$WORK/result.json"
rm -f "$OUT"
CFG_JSON=$(node -e "let c=JSON.parse(process.argv[1]); c.out=process.argv[2]; console.log(JSON.stringify(JSON.stringify(c)))" "$CFG" "$OUT")
cat > "$WORK/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$WORK/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.port", 23139);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.journal-crawler.devAutorun", $CFG_JSON);
PREFS
# force the add-on manager to rescan the proxy file
sed -i '' '/extensions.lastAppBuildId\|extensions.lastAppVersion/d' "$WORK/profile/prefs.js" 2>/dev/null || true
/Applications/Zotero.app/Contents/MacOS/zotero -profile "$WORK/profile" -no-remote -ZoteroDebugText > "$WORK/debug.log" 2>&1 &
echo "started pid $! ; result -> $OUT ; debug -> $WORK/debug.log"
