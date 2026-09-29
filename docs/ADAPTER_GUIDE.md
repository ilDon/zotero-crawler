# Journal configuration and adapter guide

Every journal in the plugin has an **adapter** (the code that knows how to list the
journal's articles) and **params** (a JSON object that configures it for that site).
Generic adapters cover whole platforms; site-specific adapters cover sites built by hand.

The plugin then, for every article the adapter yields and that was not processed in an
earlier run:
1. completes the metadata (from the landing page's `citation_*` / Dublin Core meta tags
   when the adapter asks for it with `landing: true`, or when title or PDF are missing);
2. checks the Zotero library for a duplicate (DOI, URL, title + year);
3. downloads the PDF (following one level of viewer/download pages; in Zotero a hidden
   browser is used as fallback for Cloudflare-protected downloads); with `htmlToPdf`, an
   article that has no PDF is printed to PDF from its web page;
4. creates the Zotero item (journalArticle) in the journal's collection and attaches the PDF;
5. records the article in its own database (`journal-crawler.sqlite`) so it is never
   fetched again.

## Files

| file | purpose |
|---|---|
| `addon/content/lib/util.js` | `JCUtil`: URL, text, names, dates, embedded metadata helpers |
| `addon/content/lib/adapters.js` | `JCAdapters`: registry, ctx contract (read the header comment), OAI helpers |
| `addon/content/lib/resolver.js` | landing page metadata and PDF download (shared by plugin and harness) |
| `addon/content/lib/config.js` | import/export of the journal list (JSON) |
| `addon/content/lib/htmlpdf.js` | web page → PDF (Gecko print engine) |
| `addon/content/lib/adapters/ojs.js` | Open Journal Systems (OAI-PMH or issue archive) |
| `addon/content/lib/adapters/oai.js` | generic OAI-PMH (Digital Commons / bepress, repositories) |
| `addon/content/lib/adapters/wordpress.js` | WordPress REST API (post per article, or post per issue) |
| `addon/content/lib/adapters/crawl.js` | configurable HTML crawler (issue list → issue pages, or paginated list) |
| `addon/content/lib/adapters/crossref.js` | article list from Crossref by ISSN (base of cambridge.js and mdpi.js) |
| `addon/content/lib/adapters/{cambridge,mdpi,janeway,giappichelli}.js` | publisher platforms |
| `addon/content/lib/adapters/<id>.js` | site-specific adapters |
| `addon/content/lib/profiles.js` | known sites: address prefixes → adapter, params, notes (applied when such a journal is added or imported with only title and url) |
| `test/harness.mjs` | runs an adapter in Node, without Zotero |

The journal list itself is not part of the plugin: it is kept in the user's database and
imported/exported as JSON (`addon/content/lib/config.js`).

## Testing an adapter

```
node test/harness.mjs --adapter ojs --params '{"base":"https://journals.example.edu/index.php/journal"}' --limit 5 --resolve 3 --pdf 2
node test/harness.mjs --adapter crawl --params '{…}' --since 2025 --limit 20
node test/harness.mjs --config list.json <slug> --limit 5 --resolve 3 --pdf 2   # a journal of a list (file or directory)
```

`--resolve N` does what the plugin does before import (landing page metadata, PDF candidates);
`--pdf N` downloads the PDF and checks it really is a PDF. The printed metadata is what
would end up in Zotero: check titles, authors (first/last name split), date, volume/issue.

## Params understood everywhere

| param | effect |
|---|---|
| `htmlToPdf: true` | when an article has no PDF, print its web page to PDF (HTML-only journals); a ref can also set `htmlToPdf: true` |
| `landingPdfSelector` | CSS selector of the PDF link on the article page, when the list/API gives none |
| `doiSelector` | CSS selector of the element showing the DOI on the article page (a doi.org link or text) |
| `pdfUrlTemplate` | PDF address built from the DOI: `{doi}`, or `{doi_}` with `/` replaced by `_` |
| `pdfWaitDays` | days an article without PDF is checked again (default 60), for journals that publish the PDF later |
| `contentSelector` | where to look for a PDF link on the article page (default: article, main, .entry-content…) |
| `browser: true` | render pages in Zotero's hidden browser (bot checks, JavaScript sites) |
| `delayMs` | pause between requests to the site (default 1000) |
| `plainUA: false` | keep Zotero's own User-Agent instead of a plain Firefox one |
| `skipPattern` | (ojs, oai, wordpress, crawl) regex: skip articles whose title matches |

Adapters may also define `afterLanding(ctx, ref, doc)` to correct the metadata read from the
article page (called after the merge with the adapter's own fields).

OJS 2.x OAI endpoints may skip or repeat records while paging: for those use `mode: "archive"`
or the crawl adapter.

## Writing a site-specific adapter

A plain script (no `import`/`require`), loaded in a shared scope where `JCAdapters` and
`JCUtil` (and the generic adapters' helpers `JCOai`, `JCOjs`, `JCWordPress`, `JCCrawl`) are
globals. Do all network access through `ctx` (throttling, cookies, charset, hidden browser);
use only standard DOM APIs on the documents it returns (`querySelector(All)`,
`getAttribute`, `textContent`, `closest`, `matches`) and `JCUtil.absUrl(href, doc.__url)` for
links. Register with a unique id (use the journal slug for site-specific adapters):

```js
/* global JCAdapters, JCUtil */
JCAdapters.register({
	id: 'example-journal',
	label: 'Example Journal',
	description: 'What is crawled and how, in one or two sentences.',
	params: {},               // documented params, if any
	async *discover(ctx) {
		// newest first; skip issues done in earlier runs; stop at ctx.since
		for (let issue of issues) {
			if (ctx.cancelled) return;
			if (ctx.tooOld(issue.date)) break;
			if (await ctx.isIssueDone(issue.key)) continue;
			// … fetch the issue, yield one ref per article …
			yield { key, url, pdfUrl, meta: { title, creators, date, volume, issue, pages, DOI }, issueKey: issue.key };
			// never mark the newest issue: it may still grow
			if (!issue.isNewest) ctx.markIssueDone(issue.key);
		}
	},
});
```

Rules of thumb:
- **Incremental first.** A run months after the last one must not re-read the whole site:
  skip done issues (`ctx.isIssueDone`), or for article streams use `ctx.incremental(n)`,
  or an API filter by date kept in `ctx.state`. Only listing pages should be fetched for
  content already processed.
- **Generic before custom.** Use a generic adapter with params whenever the site is
  reasonably standard; write site code only when there is no other way to get the list of
  articles with title, date and PDF.
- **Essential metadata**: title, date (at least the year), issue where easy, PDF. Authors,
  pages, DOI, abstract are welcome only when they come for free (OAI, `citation_*` meta
  tags, an obvious field in the table of contents): no site-specific code just for authors —
  they can be added by hand in Zotero.
- **Only articles**: skip editorial boilerplate (issue covers, full-issue PDFs, indexes,
  calls for papers, errata) with `skipPattern` or code.
- **Keys must be stable**: the landing URL, or the PDF URL when there is no landing page.
- Be polite: the ctx throttles per host (params.delayMs, default 800 ms in the harness,
  1000 ms in Zotero); do not parallelize requests.
- If a site needs JavaScript or shows a bot challenge to plain HTTP, set `params.browser: true`
  (pages are rendered in Zotero's hidden browser; the harness cannot do this).

## Journal entry

One entry of `"journals"` in the list file (with `scripts/config.mjs`, one file
`journals/<slug>.json` in a configuration directory). A new site adapter should come with a
profile in `profiles.js`, so that adding the journal by its address activates it:

```json
{
  "slug": "example-journal",
  "title": "Example Journal",
  "url": "https://www.example-journal.org",
  "adapter": "example-journal",
  "params": {},
  "enabled": true,
  "sinceYear": 2020,
  "notes": "What is downloaded, limits, peculiarities (shown in the window).",
  "survey": {
    "platform": "…",
    "access": "open | partial | registration | paywall",
    "metadata": "which fields are available and from where",
    "incremental": "how new content is detected cheaply",
    "botProtection": "none | cloudflare on PDFs | …",
    "verified": "harness command and result"
  }
}
```

`survey` is free-form: it is kept and shown in the window ("Analisi del sito").
