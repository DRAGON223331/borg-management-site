'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

async function main() {
  const source = path.join(__dirname, 'site-src');
  const output = path.join(__dirname, 'dist');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['index.html', 'styles.css']) {
    fs.copyFileSync(path.join(source, name), path.join(output, name));
  }
  const assetsSource = path.join(source, 'assets');
  if (fs.existsSync(assetsSource)) {
    fs.cpSync(assetsSource, path.join(output, 'assets'), { recursive: true });
  }
  await esbuild.build({
    entryPoints: [path.join(source, 'app.js')],
    outfile: path.join(output, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    sourcemap: false,
  });
  console.log('Built static UI and browser upload client into dist/');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
