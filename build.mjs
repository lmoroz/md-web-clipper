import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

// Single source of truth for the version — package.json.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const baseManifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));

for (const dir of ['dist', 'dist-firefox']) {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
}

await esbuild.build({
	entryPoints: ['src/content.js', 'src/popup.js', 'src/save.js'],
	bundle: true,
	format: 'iife',
	outdir: 'dist',
	minify: false,
	logLevel: 'info'
});

cpSync('src/popup.html', 'dist/popup.html');
cpSync('src/popup.css', 'dist/popup.css');
cpSync('src/save.html', 'dist/save.html');
cpSync('icons', 'dist/icons', { recursive: true });

// Chrome build: manifest as is, version injected.
writeFileSync('dist/manifest.json', JSON.stringify({ ...baseManifest, version }, null, '\t') + '\n');

// Firefox build: same files, plus the gecko id required by Firefox.
// No background script and no FSA dependency, so nothing else differs:
// save.js falls back to the downloads API when showDirectoryPicker is absent.
cpSync('dist', 'dist-firefox', { recursive: true });
writeFileSync('dist-firefox/manifest.json', JSON.stringify({
	...baseManifest,
	version,
	browser_specific_settings: {
		gecko: {
			id: 'md-web-clipper@lmoroz.github.io',
			strict_min_version: '115.0'
		}
	}
}, null, '\t') + '\n');

console.log(`Build ${version} done → dist/ (Chrome), dist-firefox/ (Firefox)`);
