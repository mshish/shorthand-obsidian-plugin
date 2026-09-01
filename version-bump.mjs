import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
// Two spaces and a trailing newline, not the sample plugin's tabs: .editorconfig sets
// indent_size = 2 and insert_final_newline = true for every file here, and manifest.json
// is one of the three files the marketplace installs. Left as the sample wrote it, every
// release silently reformatted the whole file and dropped its final newline, so each bump
// carried a seven-line whitespace diff that hid the one line that actually changed.
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', `${JSON.stringify(versions, null, 2)}\n`);
}
