'use strict';
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, 'site-src');
const output = path.join(__dirname, 'dist');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.js']) {
  fs.copyFileSync(path.join(source, name), path.join(output, name));
}
console.log('Vercel static frontend built into vercel-frontend/dist');
