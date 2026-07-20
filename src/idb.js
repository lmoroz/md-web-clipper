// Tiny IndexedDB key-value store shared by popup.js and save.js.
// Used to hand off the clip data (markdown + image blobs) to the save window
// and to remember the FileSystemDirectoryHandle of the chosen folder.
function openDb() {
	return new Promise((res, rej) => {
		const req = indexedDB.open('md-web-clipper', 1);
		req.onupgradeneeded = () => req.result.createObjectStore('kv');
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	});
}

async function withStore(mode, fn) {
	const db = await openDb();
	return new Promise((res, rej) => {
		const tx = db.transaction('kv', mode);
		const rq = fn(tx.objectStore('kv'));
		rq.onsuccess = () => res(rq.result);
		rq.onerror = () => rej(rq.error);
	});
}

export const kvGet = (key) => withStore('readonly', (s) => s.get(key));
export const kvSet = (key, val) => withStore('readwrite', (s) => s.put(val, key));
export const kvDel = (key) => withStore('readwrite', (s) => s.delete(key));
