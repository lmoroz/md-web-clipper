// Save window. Opened by the popup after the clip data has been put into
// IndexedDB. Prefer File System Access API (showDirectoryPicker) — writes
// straight into a user-chosen folder, handle remembered in IDB. Brave (and
// some locked-down Chromium builds) disable FSA → fall back to
// chrome.downloads into the browser Downloads folder (base.md + base_files/).
import { kvGet, kvSet, kvDel } from './idb.js';

const $ = (id) => document.getElementById(id);
let pending = null;

const canPickDir = typeof window.showDirectoryPicker === 'function';

function setStatus(text, isError) {
	const el = $('status');
	el.textContent = text || '';
	el.className = isError ? 'error' : '';
}

async function writeAll(dir) {
	const fh = await dir.getFileHandle(pending.base + '.md', { create: true });
	const w = await fh.createWritable();
	await w.write(pending.markdown);
	await w.close();
	let n = 0;
	if (pending.images && pending.images.length) {
		const sub = await dir.getDirectoryHandle(pending.base + '_files', { create: true });
		for (const img of pending.images) {
			const h = await sub.getFileHandle(img.name, { create: true });
			const ws = await h.createWritable();
			await ws.write(img.blob);
			await ws.close();
			n++;
			setStatus('Записано ' + n + ' из ' + pending.images.length + '…');
		}
	}
	return n;
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
	await downloadBlob(
		pending.base + '.md',
		new Blob([pending.markdown], { type: 'text/markdown;charset=utf-8' })
	);
	let n = 0;
	for (const img of pending.images || []) {
		n++;
		setStatus('Скачиваю картинки (' + n + '/' + pending.images.length + ')…');
		await downloadBlob(pending.base + '_files/' + img.name, img.blob);
	}
	await kvDel('pending');
	$('pick').hidden = true;
	let msg = 'Скачано в «Загрузки»: ' + pending.base + '.md';
	if (n) msg += ' + ' + n + ' карт. (папка ' + pending.base + '_files)';
	if (pending.failed) msg += ' (' + pending.failed + ' карт. не скачалось — оставлены исходные ссылки)';
	setStatus(msg);
	setTimeout(() => window.close(), pending.failed ? 4000 : 2000);
	return true;
}

function doneMsg(where, n) {
	let msg = 'Сохранено в «' + where + '»: ' + pending.base + '.md';
	if (n) msg += ' + ' + n + ' карт.';
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
	const n = await writeAll(dir);
	await kvDel('pending');
	$('pick').hidden = true;
	setStatus(doneMsg(dir.name, n));
	setTimeout(() => window.close(), pending.failed ? 4000 : 1500);
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
	$('what').textContent = pending.base + '.md' + (imgs ? ' + ' + imgs + ' карт.' : '');
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
