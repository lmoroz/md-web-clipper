// Release checker: the extension is distributed only as zips from GitHub
// Releases, so nothing updates it automatically. The popup asks the GitHub API
// for the release list (ACAO:* — no host permission needed) at most once per
// CACHE_TTL and shows what changed between the installed and the newest version.

const RELEASES_API = 'https://api.github.com/repos/lmoroz/md-web-clipper/releases?per_page=50';
const CACHE_KEY = 'mdwc.releases';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 5000;

// "v1.2.3" / "1.2.3" → [1, 2, 3]; anything else → null.
export function parseVersion(tag) {
	const m = String(tag || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
	return m ? m.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

function readCache() {
	try {
		const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
		return c && Array.isArray(c.releases) ? c : null;
	} catch {
		return null;
	}
}

function writeCache(releases) {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), releases }));
	} catch { /* storage unavailable — just refetch next time */ }
}

async function fetchReleases() {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
	try {
		const res = await fetch(RELEASES_API, {
			signal: ctrl.signal,
			headers: { Accept: 'application/vnd.github+json' },
			credentials: 'omit'
		});
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const list = await res.json();
		return list
			.filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name))
			.map((r) => ({
				tag: r.tag_name,
				url: r.html_url,
				date: r.published_at,
				body: r.body || ''
			}));
	} finally {
		clearTimeout(timer);
	}
}

async function getReleases() {
	const cached = readCache();
	if (cached && Date.now() - cached.at < CACHE_TTL) return cached.releases;
	try {
		const releases = await fetchReleases();
		writeCache(releases);
		return releases;
	} catch {
		// Offline / rate-limited (60 req/h per IP without a token): stale data
		// is better than nothing, and the next popup open retries.
		return cached ? cached.releases : [];
	}
}

// Releases newer than `current`, newest first; null when up to date.
export async function checkForUpdate(current) {
	const cur = parseVersion(current);
	if (!cur) return null;
	const newer = (await getReleases())
		.map((r) => ({ ...r, v: parseVersion(r.tag) }))
		.filter((r) => r.v && compareVersions(r.v, cur) > 0)
		.sort((a, b) => compareVersions(b.v, a.v));
	return newer.length ? newer : null;
}
