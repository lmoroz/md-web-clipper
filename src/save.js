// Save window. Opened by the popup after the clip data has been put into
// IndexedDB. Writes the md file and images straight into a user-chosen folder
// via the File System Access API (no Downloads involved). The folder handle is
// remembered, so subsequent saves are silent (or one click after a browser
// restart, when permission degrades back to 'prompt').
import { kvGet, kvSet, kvDel } from './idb.js';

const $ = (id) => document.getElementById(id);
let pending = null;

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

async function doSave(interactive) {
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
		dir = await window.showDirectoryPicker({ mode: 'readwrite' });
		await kvSet('dir', dir);
	}
	const n = await writeAll(dir);
	await kvDel('pending');
	$('pick').hidden = true;
	let msg = 'Сохранено в «' + dir.name + '»: ' + pending.base + '.md';
	if (n) msg += ' + ' + n + ' карт.';
	if (pending.failed) msg += ' (' + pending.failed + ' карт. не скачалось — оставлены исходные ссылки)';
	setStatus(msg);
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
	// Try a silent save into the remembered folder first.
	const done = await doSave(false).catch(() => false);
	if (!done) {
		$('pick').hidden = false;
		setStatus('');
	}
})();
