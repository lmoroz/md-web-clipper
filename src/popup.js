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

function extFromDataUrl(dataUrl) {
	const m = /^data:([^;,]+)/.exec(dataUrl || '');
	return (m && MIME_EXT[m[1].toLowerCase()]) || '';
}

// Collect unique image URLs from markdown ![alt](url) / ![alt](<url>)
// and from HTML <img src="..."> (complex tables are kept as HTML).
function collectImageUrls(md) {
	const urls = [];
	const add = (url) => {
		if (url && /^https?:/i.test(url) && !urls.includes(url)) urls.push(url);
	};
	const reMd = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
	let m;
	while ((m = reMd.exec(md)) !== null) add(m[1] || m[2]);
	const reImg = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
	while ((m = reImg.exec(md)) !== null) add(m[1] || m[2] || m[3]);
	return urls;
}

// Relative link destination: no <>, percent-encode the few unsafe characters.
// Names are underscore-separated already, so this is just a safety net.
function encodeRelPath(path) {
	return path.replace(/%/g, '%25').replace(/ /g, '%20')
		.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function rewriteLink(md, url, rel) {
	return md
		.split('(' + url + ')').join('(' + rel + ')')
		.split('(<' + url + '>)').join('(' + rel + ')')
		.split('src="' + url + '"').join('src="' + rel + '"')
		.split("src='" + url + "'").join("src='" + rel + "'");
}

// Runs INSIDE the page: fetches images with the page's cookies/session and
// returns {url: dataUrl | null}. This is what makes authenticated wikis work.
const fetchImagesInPage = async (urls) => {
	const out = {};
	await Promise.all(urls.map(async (u) => {
		try {
			const r = await fetch(u, { credentials: 'include' });
			if (!r.ok) throw new Error(String(r.status));
			const blob = await r.blob();
			out[u] = await new Promise((res, rej) => {
				const fr = new FileReader();
				fr.onload = () => res(fr.result);
				fr.onerror = () => rej(fr.error);
				fr.readAsDataURL(blob);
			});
		} catch (e) {
			out[u] = null;
		}
	}));
	return out;
};

// Gather everything, put it into IndexedDB and open the save window, which
// writes the files into a user-chosen folder via the File System Access API.
// (The picker cannot be shown from this popup: it closes on losing focus.)
async function saveFile() {
	const base = sanitizeName($('filename').value);
	let md = clip.markdown;
	const images = [];
	let failed = 0;

	if ($('images').checked) {
		const urls = collectImageUrls(md);
		if (urls.length) {
			setStatus('Скачиваю картинки (' + urls.length + ')…');
			let fetched = {};
			try {
				const inj = await chrome.scripting.executeScript({
					target: { tabId },
					func: fetchImagesInPage,
					args: [urls]
				});
				fetched = (inj && inj[0] && inj[0].result) || {};
			} catch (e) {
				console.warn('in-page fetch failed:', e);
			}
			const folder = base + '_files';
			let i = 0;
			for (const url of urls) {
				i++;
				const dataUrl = fetched[url];
				if (!dataUrl) {
					// Keep the original absolute URL in the markdown.
					failed++;
					continue;
				}
				const ext = extFromDataUrl(dataUrl) || extFromUrl(url) || '.jpg';
				const name = 'img-' + String(i).padStart(2, '0') + ext;
				const blob = await (await fetch(dataUrl)).blob();
				images.push({ name, blob });
				md = rewriteLink(md, url, encodeRelPath(folder + '/' + name));
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
