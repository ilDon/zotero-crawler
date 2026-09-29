# Zotero Journal Crawler

**Downloads every article of the journals you follow — PDF and metadata — into your Zotero library, and remembers what it already took.**

![Zotero 7–10](https://img.shields.io/badge/Zotero-7%20%E2%80%93%2010-cc2936)

You give the plugin a list of journals (typically open access journals without a feed or a
Zotero translator that covers their whole archive); it finds the articles published on each
site, imports them as Zotero items with their PDF, and on the next run — even months later —
only fetches what is new.

It knows the common publishing platforms — Open Journal Systems, Digital Commons (bepress),
WordPress, Cambridge Core, MDPI, Janeway, any site with OAI-PMH or Crossref records — and has a
configurable HTML crawler for hand-made sites, plus dedicated adapters for a number of sites
that need their own rules. The journal list itself starts empty.

## Install

Download the `.xpi` of the [latest release](https://github.com/ilDon/zotero-crawler/releases/latest)
and in Zotero choose *Tools → Plugins → ⚙ → Install Plugin From File…*. Updates are then
installed automatically.

## Use

Open the journals window from the button next to the search box of the items list, or from
*Tools → Riviste: scarica articoli…*.

- **Importa JSON…** loads a list of journals with their settings, for instance one exported
  from another computer; **Esporta JSON…** saves yours. **Aggiungi rivista…** adds a single
  journal: the platform of the site is recognized and the settings proposed.
- **Aggiorna tutte** looks for new articles in every enabled journal and imports them;
  **Aggiorna selezionate** does it for the checked (or selected) journals.
- **Prova** lists what would be downloaded (up to 15 articles per journal) and checks the first PDF,
  without importing anything: useful after changing a journal's settings.
- **Dal** is the first year to download (default 2024): older articles are ignored. Leave it empty
  to download whole archives. A journal can have its own year.
- Articles go to *Riviste / <journal>* (the root collection is configurable), one
  `journalArticle` item each with the PDF attached and renamed with Zotero's file naming.
  Articles published only as web pages are converted to PDF.
- Runs can be stopped at any time and resumed later; several journals are processed in parallel,
  each site at most one request per second.

For each journal the window shows its settings, notes, the articles found (added, already in the
library, waiting for the PDF, failed) and the history of runs.

### Duplicates and incremental runs

Before importing, the library is searched for the same article (DOI, URL, or same title and
year): an existing item is only added to the journal's collection, and gets the PDF if it had
none.

Every article met is recorded in the plugin's own database (`journal-crawler.sqlite`, next to
`zotero.sqlite`), so a later run never visits it again. Adapters also keep cursors: OAI-PMH and
Crossref are asked only for records changed since the last run, WordPress for posts after the
last one seen, and issue-based sites skip issues already completed. Articles whose PDF is not
available yet (some journals publish it later) are checked again in the following runs for a
configurable number of days; failed downloads are retried up to three times.
*Dimentica download* makes a journal start over (duplicates are still recognized).

### Bot protection

Some sites answer plain requests with a Cloudflare, AWS WAF or Anubis challenge. The plugin then
loads the page, or downloads the PDF, through Zotero's own hidden browser, as Zotero does when you
save from those sites.

## Journal list format

```json
{
  "format": "zotero-journal-crawler",
  "version": 1,
  "journals": [
    {
      "slug": "example-review",
      "title": "Example Law Review",
      "url": "https://journals.example.edu/index.php/elr",
      "adapter": "ojs",
      "params": { "base": "https://journals.example.edu/index.php/elr" },
      "enabled": true,
      "notes": "Free text shown in the window"
    }
  ]
}
```

The adapters and their params are described in the window and in
[docs/ADAPTER_GUIDE.md](docs/ADAPTER_GUIDE.md), which also explains how to write a site adapter.

## Development

```
npm install
npm test                                            # unit tests
node test/harness.mjs --config list.json <slug> --limit 5 --resolve 3 --pdf 2
                                                    # run a journal's adapter outside Zotero
node test/harness.mjs --config list.json --all --limit 2 --resolve 1 --pdf 1
node scripts/config.mjs pack <dir> list.json        # journal list kept as a directory → JSON
node scripts/build.mjs                              # build/*.xpi
scripts/zotero-test.sh '{"importFile":"/path/list.json","slugs":["example-review"],"since":2026,"limitPerJournal":3,"quit":true}'
                                                    # end-to-end run in a throwaway Zotero profile
```

Pushing a tag `vX.Y.Z` publishes a release with the `.xpi` and the `updates.json` used for
automatic updates (`.github/workflows/release.yml`).

## License

MIT
