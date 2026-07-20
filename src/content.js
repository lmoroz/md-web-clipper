// Injected on demand by the popup. Extracts the readable part of the page
// with Defuddle, converts it to Markdown and sends the result to the popup.
//
// Note: 'defuddle/full' is a pre-bundled build with its own copy of Turndown
// inside, so Turndown escaping cannot be patched via the prototype. Instead we
// post-process the markdown (outside code spans/blocks) to remove the two
// annoying escapes: "4\." in numbered headings and "\_" in words.
import Defuddle, { createMarkdownContent } from 'defuddle/full';

// Project items 4 and 5: undo "N\. " and "\_" escaping everywhere except
// inline code and fenced code blocks (where no escaping ever happens, so any
// backslash there is original content and must be kept).
function fixEscaping(md) {
	return md
		.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
		.map((part, i) => i % 2
			? part
			: part.replace(/(\d)\\\. /g, '$1. ').replace(/\\_/g, '_'))
		.join('');
}

// Markdown viewers only recognize a table if it is separated from surrounding
// text by blank lines. Wiki pages (e.g. Yandex Wiki) often produce a table
// glued right after a paragraph line, so insert the blank lines ourselves.
// Fenced code blocks are left untouched ("|" lines there are code).
function fixTableSpacing(md) {
	const lines = md.split('\n');
	const out = [];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (!inFence && out.length) {
			const prev = out[out.length - 1];
			const isRow = /^\s*\|/.test(line);
			const prevIsRow = /^\s*\|/.test(prev);
			if (isRow !== prevIsRow && prev.trim() !== '' && line.trim() !== '') {
				out.push('');
			}
		}
		out.push(line);
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// Internal anchor links. Wiki pages use transliterated/arbitrary ids as
// heading anchors (#svyazannaya-user-story). Those ids are lost in markdown:
// viewers build anchors from the heading TEXT (github-style slug). While we
// still have the live DOM, resolve each internal link's id to its heading and
// rewrite the anchor to the slug of the heading text.
//
// The heading TEXT is taken from the markdown, not from the DOM: DOM headings
// often contain junk (hidden "copy link" captions that duplicate the text),
// while the markdown headings are already cleaned up by Defuddle/Turndown.

function slugify(text) {
	return text.trim().toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s+/g, '-');
}

function normSpace(s) {
	return (s || '').replace(/\s+/g, ' ').trim();
}

// Plain text of a markdown heading: drop links/images and md formatting marks.
function stripMdInline(s) {
	return normSpace(
		s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~\\]/g, '')
	);
}

function mdHeadingTexts(md) {
	const out = [];
	let inFence = false;
	for (const line of md.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
		if (inFence) continue;
		const m = /^#{1,6}\s+(.+)$/.exec(line);
		if (m) out.push(stripMdInline(m[1]));
	}
	return out;
}

function findHeadingTextInDom(id) {
	const el = document.getElementById(id) ||
		(document.getElementsByName(id) || [])[0];
	if (!el) return null;
	if (/^H[1-6]$/.test(el.tagName)) return el.textContent;
	const up = el.closest && el.closest('h1,h2,h3,h4,h5,h6');
	if (up) return up.textContent;
	const inner = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6');
	if (inner) return inner.textContent;
	const next = el.nextElementSibling;
	if (next && /^H[1-6]$/.test(next.tagName)) return next.textContent;
	return null;
}

function fixInternalLinks(md) {
	const headings = mdHeadingTexts(md);
	const normed = headings.map((h) => h.toLowerCase());
	return md.replace(/\]\(#([^)\s]+)\)/g, (m0, id) => {
		let decoded = id;
		try { decoded = decodeURIComponent(id); } catch (e) { /* keep raw */ }
		let domText = findHeadingTextInDom(decoded) || findHeadingTextInDom(id);
		if (!domText) return m0;
		domText = normSpace(domText);
		const key = domText.toLowerCase();
		// Prefer the markdown heading the DOM text STARTS WITH: hidden junk in
		// the DOM heading is appended after the real caption.
		let best = '';
		let bestLen = 0;
		for (let i = 0; i < headings.length; i++) {
			if (normed[i] && key.startsWith(normed[i]) && normed[i].length > bestLen) {
				best = headings[i];
				bestLen = normed[i].length;
			}
		}
		if (!best) {
			// Fallback: de-double "TextText" -> "Text", then use the DOM text.
			const half = domText.length >> 1;
			if (domText.length % 2 === 0 &&
				domText.slice(0, half) === domText.slice(half)) {
				domText = domText.slice(0, half);
			}
			best = domText;
		}
		return '](#' + slugify(best) + ')';
	});
}
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Complex tables. Defuddle's createMarkdownContent treats ANY table that
// contains a nested <table> as a layout table and flattens all cells into a
// loose stream (see defuddle markdown.js: hasNestedTables → flatten). Wiki
// pages (Yandex Wiki) put real data tables with nested tables inside cells
// (e.g. a type→code mapping). We extract those multi-column tables as cleaned
// HTML before Turndown, then splice them back — GFM pipe tables can't hold
// lists/nested tables anyway, and HTML tables render in most viewers.

const TABLE_STUB = (i) => `@@MDWCTABLE${i}@@`;

function isDirectTableChild(el, table) {
	let p = el.parentElement;
	while (p && p !== table) {
		if (p.tagName === 'TABLE') return false;
		p = p.parentElement;
	}
	return p === table;
}

function cleanupTableHTML(table, baseUrl) {
	const allowed = new Set([
		'src', 'href', 'alt', 'title', 'style', 'align', 'width', 'height',
		'rowspan', 'colspan', 'bgcolor', 'scope', 'valign', 'headers', 'id'
	]);
	const clone = table.cloneNode(true);
	for (const junk of clone.querySelectorAll('button, script, style, svg')) {
		junk.remove();
	}
	// Absolute image URLs so popup can fetch/rewrite them (wiki often uses /path).
	if (baseUrl) {
		for (const img of clone.querySelectorAll('img[src]')) {
			try {
				img.setAttribute('src', new URL(img.getAttribute('src'), baseUrl).href);
			} catch { /* keep raw */ }
		}
	}
	const clean = (el) => {
		for (const attr of [...el.attributes]) {
			if (!allowed.has(attr.name)) el.removeAttribute(attr.name);
		}
		for (const child of el.children) clean(child);
	};
	clean(clone);
	// outerHTML encodes & as &amp;; decode so markdown viewers see real markup
	return clone.outerHTML
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function protectComplexTables(html, baseUrl) {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const stubs = [];
	for (const table of [...doc.querySelectorAll('table')]) {
		if (!table.isConnected) continue;
		const hasNested = [...table.querySelectorAll('table')].some((t) => t !== table);
		if (!hasNested) continue;
		const directCells = [...table.querySelectorAll('td, th')]
			.filter((el) => isDirectTableChild(el, table));
		const directRows = [...table.querySelectorAll('tr')]
			.filter((el) => isDirectTableChild(el, table));
		const cellCounts = directRows.map((tr) =>
			directCells.filter((c) => c.parentNode === tr).length);
		const isSingleColumn = directRows.length > 0 &&
			new Set(cellCounts).size === 1 &&
			cellCounts[0] <= 1;
		// Real layout tables: leave for Defuddle to flatten.
		if (isSingleColumn) continue;
		const id = stubs.length;
		stubs.push(cleanupTableHTML(table, baseUrl));
		const marker = doc.createElement('p');
		marker.textContent = TABLE_STUB(id);
		table.replaceWith(marker);
	}
	return { html: doc.body.innerHTML, stubs };
}

function restoreComplexTables(md, stubs) {
	for (let i = 0; i < stubs.length; i++) {
		const token = TABLE_STUB(i);
		if (!md.includes(token)) continue;
		md = md.split(token).join('\n\n' + stubs[i] + '\n\n');
	}
	return md;
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Comment blocks (Yandex Tracker and similar). Defuddle strips <header>
// elements inside comments as clutter, losing the author and the date; and
// relative dates ("2 часа назад") are useless in a saved archive. We parse a
// CLONE of the document where:
// - every <time datetime="..."> gets absolute "dd.mm.yyyy hh:mm" text;
// - every <article> <header> that looks like a comment header (has <time>,
//   no h1/h2) is replaced with a plain paragraph "**Author — date**".

function fmtDate(iso) {
	const d = new Date(iso);
	if (isNaN(d)) return null;
	const p = (n) => String(n).padStart(2, '0');
	return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
		' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// textContent glues adjacent elements together ("призвалНину"); this walker
// joins text nodes with spaces instead.
function textWithSpaces(el) {
	let s = '';
	const walk = (n) => {
		if (n.nodeType === 3) { s += n.textContent + ' '; return; }
		if (n.nodeType === 1) { for (const c of n.childNodes) walk(c); }
	};
	walk(el);
	return normSpace(s);
}

function prepareDoc() {
	const doc = document.cloneNode(true);
	const base = document.URL;
	for (const t of doc.querySelectorAll('time[datetime]')) {
		const s = fmtDate(t.getAttribute('datetime'));
		if (s) t.textContent = s;
	}
	// Prefer full-size source when CMS provides it (Pikabu data-large-image).
	for (const img of doc.querySelectorAll('img[data-large-image]')) {
		const large = img.getAttribute('data-large-image');
		if (large) img.setAttribute('src', large);
	}
	// Absolute image URLs (Tracker/Wiki often use /ajax/... or /path/.files/...).
	// Otherwise markdown keeps relatives and popup skips them (only http(s)).
	for (const img of doc.querySelectorAll('img[src]')) {
		try {
			img.setAttribute('src', new URL(img.getAttribute('src'), base).href);
		} catch { /* keep raw */ }
	}
	// Caption lives next to the image (Pikabu .story-block__title, <figcaption>).
	// Alt often duplicates it — sometimes with raw HTML dumped into the attribute,
	// which becomes `![...<a href>...](img)` plus a ghost paragraph from that HTML.
	// Use the caption's plain text as alt (keeps ![text](img)); the caption
	// paragraph itself stays so links inside it survive.
	for (const block of doc.querySelectorAll('.story-block, figure')) {
		const caption = block.querySelector('.story-block__title, figcaption');
		const capText = caption ? normSpace(caption.textContent) : '';
		if (!capText) continue;
		for (const img of block.querySelectorAll('img')) {
			img.setAttribute('alt', capText);
		}
	}
	// Any leftover alt that still embeds markup → plain text only.
	for (const img of doc.querySelectorAll('img[alt]')) {
		const alt = img.getAttribute('alt') || '';
		if (!/[<>]/.test(alt)) continue;
		const tmp = doc.createElement('div');
		tmp.innerHTML = alt;
		img.setAttribute('alt', normSpace(tmp.textContent || ''));
	}
	// title="https://same-as-href" is noise (Pikabu/LOR) → drop it.
	for (const a of doc.querySelectorAll('a[href][title]')) {
		const href = a.getAttribute('href') || '';
		const title = a.getAttribute('title') || '';
		if (href && title && href === title) a.removeAttribute('title');
	}
	// Defuddle EXACT_SELECTORS removes a[href^="#"][class*="anchor"] entirely.
	// Yandex Wiki puts the ONLY cell label in a.wiki-anchor — unwrap those so the
	// text survives. Do NOT touch heading clipboard anchors (yfm-clipboard-anchor):
	// Defuddle must still strip them, otherwise headings become
	// "Title:#Title" (visually-hidden + # button + visible text).
	for (const a of doc.querySelectorAll('a.wiki-anchor')) {
		const span = doc.createElement('span');
		const id = a.getAttribute('name') ||
			(a.getAttribute('href') || '').replace(/^#/, '');
		if (id) span.id = id;
		while (a.firstChild) span.appendChild(a.firstChild);
		a.replaceWith(span);
	}
	for (const header of doc.querySelectorAll('article header')) {
		if (!header.querySelector('time')) continue;
		if (header.querySelector('h1, h2')) continue; // a real article header
		const h = header.cloneNode(true);
		for (const junk of h.querySelectorAll('button, svg')) junk.remove();
		const timeEl = h.querySelector('time');
		const timeText = timeEl ? normSpace(timeEl.textContent) : '';
		if (timeEl) timeEl.remove();
		const author = textWithSpaces(h);
		if (!author && !timeText) continue;
		const p = doc.createElement('p');
		const strong = doc.createElement('strong');
		const i = doc.createElement('i');
		i.textContent = author;
		if (timeText) strong.textContent = ' ' + timeText;
		strong.prepend(i);
		const hr = doc.createElement('hr');
		p.appendChild(hr);
		p.appendChild(strong);
		header.replaceWith(p);
	}
	return doc;
}
// ---------------------------------------------------------------------------

function normalizeTitle(s) {
	return normSpace(s);
}

(function clip() {
	try {
		const result = new Defuddle(prepareDoc(), { url: document.URL }).parse();
		const extracted = protectComplexTables(result.content || '', document.URL);
		let markdown = createMarkdownContent(extracted.html, document.URL).trim();
		markdown = restoreComplexTables(markdown, extracted.stubs);
		markdown = fixEscaping(markdown);
		markdown = fixTableSpacing(markdown);
		markdown = fixInternalLinks(markdown);
		const title = normalizeTitle(result.title || document.title) || 'Untitled';

		// Project item 6: the page title always becomes the H1 of the document.
		const firstLine = markdown.split('\n', 1)[0] || '';
		const firstIsSameH1 =
			firstLine.startsWith('# ') &&
			normalizeTitle(firstLine.slice(2)).toLowerCase() === title.toLowerCase();
		if (!firstIsSameH1) {
			markdown = '# ' + title + '\n\n' + markdown;
		}
		// Project item 1: no frontmatter / properties block - we never add one.

		chrome.runtime.sendMessage({
			type: 'clip-result',
			data: { title, markdown, url: document.URL }
		});
	} catch (err) {
		chrome.runtime.sendMessage({
			type: 'clip-error',
			error: String(err && err.message ? err.message : err)
		});
	}
})();
