import { kvGet, kvSet } from './idb.js';

const $ = (id) => document.getElementById(id);
let clip = null;
let tabId = null;
let askDir = false; // user wants to pick a (different) folder on this save

function setStatus(text, isError) {
	const el = $('status');
	el.textContent = text || '';
	el.className = isError ? 'error' : '';
}

// Windows-safe file/folder name; spaces become underscores.
function sanitizeName(name) {
	return name
		.replace(/[<>:"/\\|?*]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[. ]+$/, '')
		.replace(/ /g, '_')
		.slice(0, 120) || 'untitled';
}

const MIME_EXT = {
	'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
	'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
	'image/bmp': '.bmp', 'image/x-icon': '.ico'
};

function extFromUrl(url) {
	try {
		const m = new URL(url).pathname.match(/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i);
		return m ? m[0].toLowerCase().replace('.jpeg', '.jpg') : '';
	} catch {
		return '';
	}
}

// Collect unique image URLs from markdown ![alt](url) / ![alt](<url>)
// and from HTML <img src="..."> (complex tables are kept as HTML).
// Relative paths (/ajax/v2/attachments/…) are resolved against pageUrl.
// Returns { urls, forms }: absolute URLs to fetch, and every spelling that
// appears in the markdown (so rewrite can replace both /path and https://…).
function collectImageUrls(md, pageUrl) {
	const urls = [];
	const forms = new Map(); // abs -> Set of raw forms in md
	const add = (raw) => {
		if (!raw || /^data:/i.test(raw)) return;
		let abs;
		try {
			abs = new URL(raw, pageUrl || undefined).href;
		} catch {
			return;
		}
		if (!/^https?:/i.test(abs)) return;
		if (!forms.has(abs)) {
			forms.set(abs, new Set());
			urls.push(abs);
		}
		forms.get(abs).add(raw);
		forms.get(abs).add(abs);
	};
	const reMd = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
	let m;
	while ((m = reMd.exec(md)) !== null) add(m[1] || m[2]);
	const reImg = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
	while ((m = reImg.exec(md)) !== null) add(m[1] || m[2] || m[3]);
	return { urls, forms };
}

// Relative link destination: no <>, percent-encode the few unsafe characters.
// Names are underscore-separated already, so this is just a safety net.
function encodeRelPath(path) {
	return path.replace(/%/g, '%25').replace(/ /g, '%20')
		.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function rewriteLink(md, urlOrForms, rel) {
	const forms = typeof urlOrForms === 'string' ? [urlOrForms] : [...urlOrForms];
	for (const url of forms) {
		md = md
			.split('(' + url + ')').join('(' + rel + ')')
			.split('(<' + url + '>)').join('(' + rel + ')')
			.split('src="' + url + '"').join('src="' + rel + '"')
			.split("src='" + url + "'").join("src='" + rel + "'");
	}
	return md;
}

// Runs INSIDE the page: fetch ONE image with the page's cookies/session.
// Tracker attachments 302 to storage.mds.yandex.net with ACAO:* — that combo
// fails CORS when credentials:'include' (browser forbids * with credentials).
// Use same-origin cookies for the Tracker hop, then omit on the CDN URL.
const fetchOneImageInPage = async (url) => {
	try {
		// Happy path: same-origin (or CDN without cookies).
		const r = await fetch(url, {
			credentials: 'same-origin',
			cache: 'no-cache',
			redirect: 'follow'
		});
		if (r.ok) return await encodeBlob(await r.blob());
	} catch { /* likely CORS on credentialed redirect — fall through */ }

	try {
		// Explicit hop: read Location from Tracker 302, fetch CDN without cookies.
		const r1 = await fetch(url, {
			credentials: 'same-origin',
			cache: 'no-cache',
			redirect: 'manual'
		});
		if (r1.status >= 300 && r1.status < 400) {
			const loc = r1.headers.get('Location');
			if (!loc) return { ok: false, err: 'redirect without Location' };
			const abs = new URL(loc, url).href;
			const r2 = await fetch(abs, {
				credentials: 'omit',
				cache: 'no-cache',
				redirect: 'follow'
			});
			if (!r2.ok) return { ok: false, err: 'http ' + r2.status };
			return await encodeBlob(await r2.blob());
		}
		if (r1.ok) return await encodeBlob(await r1.blob());
		return { ok: false, err: 'http ' + r1.status };
	} catch (e) {
		return { ok: false, err: String(e && e.message ? e.message : e) };
	}

	function encodeBlob(blob) {
		const type = (blob.type || '').toLowerCase();
		// Reject HTML/JSON login-or-error bodies Tracker sometimes returns.
		if (type.startsWith('text/') || type.includes('html') || type.includes('json')) {
			return { ok: false, err: 'not-image:' + type };
		}
		return blob.arrayBuffer().then((buf) => {
			const bytes = new Uint8Array(buf);
			if (!bytes.length) return { ok: false, err: 'empty' };
			if (!type.startsWith('image/') && !looksLikeImage(bytes)) {
				return { ok: false, err: 'not-image:' + (type || 'unknown') };
			}
			// Chunked btoa — String.fromCharCode(...hugeArray) blows the stack.
			let bin = '';
			const step = 0x8000;
			for (let i = 0; i < bytes.length; i += step) {
				bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
			}
			return {
				ok: true,
				type: type.startsWith('image/') ? type : sniffMime(bytes),
				b64: btoa(bin)
			};
		});
	}

	function looksLikeImage(b) {
		if (b.length < 4) return false;
		if (b[0] === 0x89 && b[1] === 0x50) return true; // PNG
		if (b[0] === 0xff && b[1] === 0xd8) return true; // JPEG
		if (b[0] === 0x47 && b[1] === 0x49) return true; // GIF
		if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true; // WEBP
		return false;
	}

	function sniffMime(b) {
		if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
		if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
		if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
		if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
		return 'image/png';
	}
};

function b64ToBlob(type, b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: type || 'image/png' });
}

// Gather everything, put it into IndexedDB and open the save window, which
// writes the files into a user-chosen folder via the File System Access API.
// (The picker cannot be shown from this popup: it closes on losing focus.)
async function saveFile() {
	const base = sanitizeName($('filename').value);
	let md = clip.markdown;
	const images = [];
	let failed = 0;

	if ($('images').checked) {
		const { urls, forms } = collectImageUrls(md, clip.url);
		if (urls.length) {
			const folder = base + '_files';
			let i = 0;
			for (const url of urls) {
				i++;
				setStatus('Скачиваю картинки (' + i + '/' + urls.length + ')…');
				let result = null;
				try {
					const inj = await chrome.scripting.executeScript({
						target: { tabId },
						func: fetchOneImageInPage,
						args: [url]
					});
					result = inj && inj[0] && inj[0].result;
				} catch (e) {
					console.warn('in-page fetch failed:', url, e);
				}
				if (!result || !result.ok || !result.b64) {
					failed++;
					continue;
				}
				const blob = b64ToBlob(result.type, result.b64);
				const ext = MIME_EXT[(result.type || '').toLowerCase()] ||
					extFromUrl(url) || '.png';
				const name = 'img-' + String(i).padStart(2, '0') + ext;
				images.push({ name, blob });
				md = rewriteLink(md, forms.get(url) || url, encodeRelPath(folder + '/' + name));
			}
		}
	}

	await kvSet('pending', { base, markdown: md, images, failed, forcePicker: askDir });
	await chrome.windows.create({
		url: 'save.html',
		type: 'popup',
		width: 460,
		height: 200
	});
	window.close();
}

async function copyToClipboard() {
	await navigator.clipboard.writeText(clip.markdown);
	setStatus('Markdown скопирован в буфер обмена');
}

function onClip(data) {
	clip = data;
	$('filename').value = sanitizeName(data.title);
	$('preview').value = data.markdown;
	$('save').disabled = false;
	$('copy').disabled = false;
	setStatus('');
}

async function refreshDirRow() {
	if (typeof showDirectoryPicker !== 'function') {
		$('dirName').textContent = 'Загрузки браузера (выбор папки недоступен)';
		$('changeDir').hidden = true;
		return;
	}
	const dir = askDir ? null : await kvGet('dir').catch(() => null);
	$('dirName').textContent = dir ? dir.name : 'будет выбрана при сохранении';
	$('changeDir').hidden = !dir;
}

$('changeDir').addEventListener('click', (e) => {
	e.preventDefault();
	askDir = true;
	refreshDirRow();
});
$('save').addEventListener('click', () => saveFile().catch((e) => setStatus(String(e), true)));
$('copy').addEventListener('click', () => copyToClipboard().catch((e) => setStatus(String(e), true)));
$('preview').addEventListener('input', () => { if (clip) clip.markdown = $('preview').value; });

chrome.runtime.onMessage.addListener((msg) => {
	if (msg && msg.type === 'clip-result') onClip(msg.data);
	if (msg && msg.type === 'clip-error') setStatus('Ошибка извлечения: ' + msg.error, true);
});

(async () => {
	setStatus('Извлекаю страницу…');
	refreshDirRow();
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab || !/^https?:/i.test(tab.url || '')) {
		setStatus('Эту страницу сохранить нельзя (не http/https).', true);
		return;
	}
	tabId = tab.id;
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
	} catch (e) {
		setStatus('Не удалось внедрить скрипт: ' + e.message, true);
	}
})();
