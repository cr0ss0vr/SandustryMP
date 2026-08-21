// ============================================================================
// SandustryMP - verify patch anchors against a new game build.
// After each Sandustry update, download the main-branch depot from the Steam console:
// `download_depot 2764460 2764461`, then run:
// `node src/check-anchors.js <bundle.js or depot folder>`.
// Reports OK, ALREADY, MISS, or AMBIGUOUS for each patch variant.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

let target = process.argv[2];
if (!target) { console.error('Usage: node src/check-anchors.js <bundle.js | depot folder>'); process.exit(1); }

// For a folder, locate `dist/js/bundle.js` in either packed or unpacked depot layouts.
if (fs.statSync(target).isDirectory()) {
  const cands = [
    path.join(target, 'dist', 'js', 'bundle.js'),
    path.join(target, 'resources', 'app', 'dist', 'js', 'bundle.js'),
  ];
  const hit = cands.find((c) => fs.existsSync(c));
  if (hit) target = hit;
  else {
    // If only `app.asar` exists, extract `bundle.js` directly with the same parser used by install.js.
    const asar = [path.join(target, 'resources', 'app.asar'), path.join(target, 'app.asar')].find((c) => fs.existsSync(c));
    if (!asar) { console.error('Could not find bundle.js or app.asar under: ' + target); process.exit(1); }
    const buf = fs.readFileSync(asar);
    const headerSize = buf.readUInt32LE(4);
    const jsonLen = buf.readUInt32LE(12);
    const index = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));
    const node = index.files.dist && index.files.dist.files.js && index.files.dist.files.js.files['bundle.js'];
    if (!node || node.offset === undefined) { console.error('bundle.js was not found inside app.asar or its unpacked files'); process.exit(1); }
    const base = 8 + headerSize;
    const off = base + Number(node.offset);
    const out = path.join(require('os').tmpdir(), 'sandustry-bundle-' + node.size + '.js');
    fs.writeFileSync(out, buf.subarray(off, off + node.size));
    console.log('Extracted bundle.js from app.asar ->', out);
    target = out;
  }
}

const bundle = fs.readFileSync(target, 'utf8');
console.log('Bundle:', target, '(' + Math.round(bundle.length / 1024) + ' KB)');

// Print the game version when a neighboring package.json is available.
for (const pj of [path.join(path.dirname(target), '..', '..', 'package.json')]) {
  try { console.log('Game version:', JSON.parse(fs.readFileSync(pj, 'utf8')).version); } catch (e) {}
}

const count = (s) => { let n = 0, i = -1; while ((i = bundle.indexOf(s, i + 1)) >= 0) n++; return n; };
const patches = require('./patches.json');
let ok = 0, already = 0, miss = 0, ambig = 0;
for (const p of patches.bundle) {
  let best = null; // Best result among variants.
  for (const [vi, v] of p.variants.entries()) {
    const na = count(v.anchor), np = count(v.patched);
    let st;
    if (np > 0) st = 'ALREADY';
    else if (na === 1) st = 'OK';
    else if (na === 0) st = 'MISS';
    else st = 'AMBIGUOUS(' + na + ')';
    if (!best || st === 'OK' || (st === 'ALREADY' && best.st.indexOf('OK') < 0)) best = { st, vi };
    if (st === 'OK' || st === 'ALREADY') break; // One matching variant is sufficient.
  }
  const mark = best.st === 'OK' ? '[OK]  ' : best.st === 'ALREADY' ? '[=]   ' : best.st.startsWith('AMBIG') ? '[!?]  ' : '[MISS]';
  if (best.st === 'OK') ok++; else if (best.st === 'ALREADY') already++; else if (best.st === 'MISS') miss++; else ambig++;
  console.log(mark, p.name, '(variant ' + best.vi + (p.critical ? ', CRITICAL' : '') + ')');
}
console.log('\nSummary: OK=' + ok + '  ALREADY=' + already + '  MISS=' + miss + '  AMBIGUOUS=' + ambig + '  / ' + patches.bundle.length);
process.exit(miss + ambig > 0 ? 2 : 0);
