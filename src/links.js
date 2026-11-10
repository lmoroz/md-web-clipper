// Link helpers shared by the popup (images) and the save window (video/audio).

// Relative link destination: no <>, percent-encode the few unsafe characters.
// Names are underscore-separated already, so this is just a safety net.
export function encodeRelPath(path) {
	return path.replace(/%/g, '%25').replace(/ /g, '%20')
		.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// Replace every spelling of a URL in markdown links and HTML src attributes.
export function rewriteLink(md, urlOrForms, rel) {
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
