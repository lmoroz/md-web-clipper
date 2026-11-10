// Save window. Opened by the popup after the clip data has been put into
// IndexedDB. Prefer File System Access API (showDirectoryPicker) — writes
// straight into a user-chosen folder, handle remembered in IDB. Brave (and
// some locked-down Chromium builds) disable FSA → fall back to
// chrome.downloads into the browser Downloads folder (base.md + base_files/).
//
// Video/audio (pending.media: [{url, kind, forms}]) are NOT in IndexedDB:
// they can weigh hundreds of MB each, so they are streamed from the network
// straight into the target folder (fetch body → FileSystemWritableFileStream),
// or handed to chrome.downloads in the fallback. The markdown is written LAST:
// a media link becomes relative only if its file was actually saved.
import { kvGet, kvSet, kvDel } from './idb.js';
import { encodeRelPath, rewriteLink } from './links.js';

const $ = (id) => document.getElementById(id);
let pending = null;
let savedMedia = 0;
let failedMedia = 0;

const canPickDir = typeof window.showDirectoryPicker === 'function';

function setStatus(text, isError) {
	const el = $('status');
	el.textContent = text || '';
	el.className = isError ? 'error' : '';
}

const MEDIA_EXT = {
	'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
	'video/ogg': '.ogv', 'video/x-matroska': '.mkv', 'video/x-m4v': '.m4v',
	'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
	'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
	'audio/webm': '.weba', 'audio/flac': '.flac', 'audio/aac': '.aac'
};
const MEDIA_EXT_RE = /\.(mp4|m4v|webm|mov|ogv|mkv|mp3|m4a|ogg|oga|wav|weba|flac|aac)$/i;

function mediaExtFromUrl(url) {
	try {
		const m = new URL(url).pathname.match(MEDIA_EXT_RE);
		return m ? m[0].toLowerCase() : '';
	} catch {
		return '';
	}
}

function mediaName(m, i, type) {
	const ext = MEDIA_EXT[type] || mediaExtFromUrl(m.url) ||
		(m.kind === 'aud' ? '.mp3' : '.mp4');
	return m.kind + '-' + String(i + 1).padStart(2, '0') + ext;
}

function fmtMB(bytes) {
	return (bytes / 1024 ** 2).toFixed(0);
}

// Cookies first (closed wikis); a CDN answering ACAO:* rejects credentialed
// CORS, so retry without them. Only real media is accepted: an HLS/DASH
// manifest or an HTML login page must not land on disk as "video.mp4".
async function fetchMedia(url) {
	let r;
	try {
		r = await fetch(url, { credentials: 'include', cache: 'no-store' });
	} catch {
		r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
	}
	if (!r.ok) throw new Error('http ' + r.status);
	const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	const isMedia = /^(video|audio)\//.test(type) && !/mpegurl|dash/.test(type);
	const isBinary = /octet-stream/.test(type) && MEDIA_EXT_RE.test(new URL(r.url || url).pathname);
	if (!isMedia && !isBinary) {
		r.body && r.body.cancel().catch(() => {});
		throw new Error('not-media:' + type);
	}
	return { r, type };
}

async function streamMedia(sub, m, i, n) {
	const { r, type } = await fetchMedia(m.url);
	const name = mediaName(m, i, type);
	const total = +r.headers.get('content-length') || 0;
	const label = 'Видео ' + (i + 1) + '/' + n;
	let done = 0;
	let shown = 0;
	const progress = new TransformStream({
		transform(chunk, ctl) {
			done += chunk.byteLength;
			if (done - shown > 512 * 1024) {
				shown = done;
				setStatus(label + ': ' + fmtMB(done) + (total ? ' / ' + fmtMB(total) : '') + ' МБ');
			}
			ctl.enqueue(chunk);
		}
	});
	const fh = await sub.getFileHandle(name, { create: true });
	try {
		// pipeTo closes the writable on success and aborts it (discarding the
		// swap file) on a network error.
		await r.body.pipeThrough(progress).pipeTo(await fh.createWritable());
	} catch (e) {
		await sub.removeEntry(name).catch(() => {});
		throw e;
	}
	return name;
}

async function writeMedia(getSub, md) {
	const list = pending.media || [];
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		setStatus('Видео ' + (i + 1) + '/' + list.length + '…');
		try {
			const name = await streamMedia(await getSub(), m, i, list.length);
			md = rewriteLink(md, m.forms, encodeRelPath(pending.base + '_files/' + name));
			savedMedia++;
		} catch (e) {
			console.warn('media not saved:', m.url, e);
			failedMedia++;
		}
	}
	return md;
}

async function writeAll(dir) {
	let sub = null;
	const getSub = async () => sub ||
		(sub = await dir.getDirectoryHandle(pending.base + '_files', { create: true }));
	let n = 0;
	for (const img of pending.images || []) {
		const h = await (await getSub()).getFileHandle(img.name, { create: true });
		const ws = await h.createWritable();
		await ws.write(img.blob);
		await ws.close();
		n++;
		setStatus('Записано ' + n + ' из ' + pending.images.length + '…');
	}
	const md = await writeMedia(getSub, pending.markdown);
	const fh = await dir.getFileHandle(pending.base + '.md', { create: true });
	const w = await fh.createWritable();
	await w.write(md);
	await w.close();
	return n;
}

// chrome.downloads resolves on START; wait for the file to actually finish
// before the markdown is allowed to point at it.
function waitDownload(id) {
	return new Promise((resolve) => {
		const finish = (ok) => {
			chrome.downloads.onChanged.removeListener(onChanged);
			resolve(ok);
		};
		const onChanged = (d) => {
			if (d.id !== id || !d.state) return;
			if (d.state.current === 'complete') finish(true);
			else if (d.state.current === 'interrupted') finish(false);
		};
		chrome.downloads.onChanged.addListener(onChanged);
		chrome.downloads.search({ id }, (items) => {
			const d = items && items[0];
			if (d && d.state === 'complete') finish(true);
			else if (d && d.state === 'interrupted') finish(false);
		});
	});
}

// Fallback path: the browser downloads the URL itself (its own cookies, no
// CORS), so there is no content-type check — the extension comes from the URL.
async function downloadMediaFallback(md) {
	const list = pending.media || [];
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		setStatus('Скачиваю видео (' + (i + 1) + '/' + list.length + ')…');
		const name = mediaName(m, i, '');
		try {
			const id = await new Promise((resolve, reject) => {
				chrome.downloads.download(
					{ url: m.url, filename: pending.base + '_files/' + name, saveAs: false, conflictAction: 'uniquify' },
					(dlId) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(dlId))
				);
			});
			if (!(await waitDownload(id))) throw new Error('interrupted');
			md = rewriteLink(md, m.forms, encodeRelPath(pending.base + '_files/' + name));
			savedMedia++;
		} catch (e) {
			console.warn('media not downloaded:', m.url, e);
			failedMedia++;
		}
	}
	return md;
}

// Closing this window mid-download silently loses the rest.
function guardUnload(on) {
	window.onbeforeunload = on ? (e) => { e.preventDefault(); e.returnValue = ''; } : null;
}

function mediaNote() {
	let s = '';
	if (savedMedia) s += ' + ' + savedMedia + ' видео';
	if (failedMedia) s += ' (' + failedMedia + ' видео не скачалось — оставлены исходные ссылки)';
	return s;
}

function downloadBlob(filename, blob) {
	const url = URL.createObjectURL(blob);
	return new Promise((resolve, reject) => {
		chrome.downloads.download(
			{ url, filename, saveAs: false, conflictAction: 'uniquify' },
			(id) => {
				// Keep the blob URL alive until Chrome starts the download.
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
				if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
				else resolve(id);
			}
		);
	});
}

async function downloadFallback() {
	setStatus('Скачиваю в «Загрузки»…');
	$('pick').hidden = true;
	guardUnload(true);
	let n = 0;
	try {
		for (const img of pending.images || []) {
			n++;
			setStatus('Скачиваю картинки (' + n + '/' + pending.images.length + ')…');
			await downloadBlob(pending.base + '_files/' + img.name, img.blob);
		}
		const md = await downloadMediaFallback(pending.markdown);
		await downloadBlob(
			pending.base + '.md',
			new Blob([md], { type: 'text/markdown;charset=utf-8' })
		);
	} finally {
		guardUnload(false);
	}
	await kvDel('pending');
	let msg = 'Скачано в «Загрузки»: ' + pending.base + '.md';
	if (n) msg += ' + ' + n + ' карт. (папка ' + pending.base + '_files)';
	msg += mediaNote();
	if (pending.failed) msg += ' (' + pending.failed + ' карт. не скачалось — оставлены исходные ссылки)';
	setStatus(msg);
	setTimeout(() => window.close(), pending.failed || failedMedia ? 6000 : 2000);
	return true;
}

function doneMsg(where, n) {
	let msg = 'Сохранено в «' + where + '»: ' + pending.base + '.md';
	if (n) msg += ' + ' + n + ' карт.';
	msg += mediaNote();
	if (pending.failed) msg += ' (' + pending.failed + ' карт. не скачалось — оставлены исходные ссылки)';
	return msg;
}

async function doSave(interactive) {
	if (!canPickDir) {
		if (!interactive) return false;
		return downloadFallback();
	}

	let dir = pending.forcePicker ? null : await kvGet('dir').catch(() => null);
	try {
		if (dir) {
			let p = await dir.queryPermission({ mode: 'readwrite' });
			if (p !== 'granted' && interactive) {
				p = await dir.requestPermission({ mode: 'readwrite' });
			}
			if (p !== 'granted') dir = null;
		}
	} catch {
		dir = null;
	}
	if (!dir) {
		if (!interactive) return false;
		try {
			dir = await window.showDirectoryPicker({ mode: 'readwrite' });
		} catch (e) {
			// Brave sometimes exposes a stub that throws / isn't callable at runtime.
			if (e && e.name === 'AbortError') throw e;
			return downloadFallback();
		}
		await kvSet('dir', dir);
	}
	$('pick').hidden = true;
	guardUnload(true);
	let n;
	try {
		n = await writeAll(dir);
	} finally {
		guardUnload(false);
	}
	await kvDel('pending');
	setStatus(doneMsg(dir.name, n));
	setTimeout(() => window.close(), pending.failed || failedMedia ? 6000 : 1500);
	return true;
}

$('pick').addEventListener('click', () => {
	doSave(true).catch((e) => {
		if (e && e.name === 'AbortError') setStatus('Выбор папки отменён.');
		else setStatus(String(e), true);
	});
});

(async () => {
	pending = await kvGet('pending');
	if (!pending) {
		setStatus('Нет данных для сохранения.', true);
		return;
	}
	const imgs = pending.images ? pending.images.length : 0;
	const vids = pending.media ? pending.media.length : 0;
	$('what').textContent = pending.base + '.md' + (imgs ? ' + ' + imgs + ' карт.' : '') +
		(vids ? ' + ' + vids + ' видео' : '');
	if (!canPickDir) {
		$('pick').textContent = 'Скачать в «Загрузки»';
		$('pick').hidden = false;
		setStatus('В этом браузере выбор папки недоступен — файлы уйдут в Загрузки.');
		return;
	}
	// Try a silent save into the remembered folder first.
	const done = await doSave(false).catch(() => false);
	if (!done) {
		$('pick').hidden = false;
		setStatus('');
	}
})();
