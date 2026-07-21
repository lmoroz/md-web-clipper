// Pack dist/ and dist-firefox/ into release zips: release/md-web-clipper-<browser>-v<version>.zip
import AdmZip from 'adm-zip';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync('release', { recursive: true, force: true });
mkdirSync('release', { recursive: true });

for (const [dir, browser] of [['dist', 'chrome'], ['dist-firefox', 'firefox']]) {
	const zip = new AdmZip();
	zip.addLocalFolder(dir);
	const name = `release/md-web-clipper-${browser}-v${version}.zip`;
	zip.writeZip(name);
	console.log('Packed', name);
}
