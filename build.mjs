import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
	entryPoints: ['src/content.js', 'src/popup.js', 'src/save.js'],
	bundle: true,
	format: 'iife',
	outdir: 'dist',
	minify: false,
	logLevel: 'info'
});

cpSync('src/manifest.json', 'dist/manifest.json');
cpSync('src/popup.html', 'dist/popup.html');
cpSync('src/popup.css', 'dist/popup.css');
cpSync('src/save.html', 'dist/save.html');
cpSync('icons', 'dist/icons', { recursive: true });
console.log('Build done → dist/');
