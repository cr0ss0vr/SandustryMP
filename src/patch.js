// ============================================================================
// SandustryMP — co-op multiplayer mod for Sandustry
// Author: Cr0ss0vr
// Patcher: applies the mod onto the unpacked game copy (resources/app).
// Idempotent — safe to run repeatedly and after every game update.
// Usage: node patch.js [path-to-resources/app]
// ============================================================================

'use strict';
const fs = require('fs');
const path = require('path');

const appPath = process.argv[2] || 'F:/SteamLibrary/steamapps/common/Sandustry/resources/app';
const sourceDirectory = __dirname;

const readTextFile = (filePath) => fs.readFileSync(filePath, 'utf8');
const writeTextFile = (filePath, contents) => fs.writeFileSync(filePath, contents, 'utf8');
let changes = 0;
const recordAppliedChange = (message) => { changes++; console.log('  [+]', message); };
const recordSkippedChange = (message) => console.log('  [=]', message, '(already applied)');

function patchSimulationWorker(workerPath) {
  const MARK_A = '// --- SandustryMP deterministic simulation RNG ---';
  const MARK_B = '// --- /SandustryMP deterministic simulation RNG ---';
  let worker = readTextFile(workerPath);
  const start = worker.indexOf(MARK_A);
  if (start >= 0) {
    const end = worker.indexOf(MARK_B, start);
    if (end < 0) throw new Error('simulation-worker.js has an incomplete SandustryMP RNG block');
    worker = worker.slice(0, start) + worker.slice(end + MARK_B.length).replace(/^\s+/, '');
  }
  const bootstrap = readTextFile(path.join(sourceDirectory, 'sim-worker-bootstrap.js')).trimEnd();
  writeTextFile(workerPath, bootstrap + '\n' + worker);
}

console.log('SandustryMP patcher - target:', appPath);
if (!fs.existsSync(path.join(appPath, 'main.js'))) { console.error('ERROR: main.js not found in ' + appPath); process.exit(1); }

// 1. Copy mod files
fs.copyFileSync(path.join(sourceDirectory, 'localisation.js'), path.join(appPath, 'dist/js/localisation.js'));
recordAppliedChange('dist/js/localisation.js copied');
fs.copyFileSync(path.join(sourceDirectory, 'state.js'), path.join(appPath, 'dist/js/state.js'));
recordAppliedChange('dist/js/state.js copied');
fs.copyFileSync(path.join(sourceDirectory, 'network.js'), path.join(appPath, 'dist/js/network.js'));
recordAppliedChange('dist/js/network.js copied');
fs.copyFileSync(path.join(sourceDirectory, 'menu.js'), path.join(appPath, 'dist/js/menu.js'));
recordAppliedChange('dist/js/menu.js copied');
fs.copyFileSync(path.join(sourceDirectory, 'sandustrymp.js'), path.join(appPath, 'dist/js/sandustrymp.js'));
recordAppliedChange('dist/js/sandustrymp.js copied');
fs.copyFileSync(path.join(sourceDirectory, 'smp-main.js'), path.join(appPath, 'smp-main.js'));
recordAppliedChange('smp-main.js copied');

// 2. index.html - <script> tag before bundle.js
{
  const filePath = path.join(appPath, 'dist/index.html');
  let contents = readTextFile(filePath);
  const requiredScripts = '    <script src="js/localisation.js"></script>\n    <script src="js/state.js"></script>\n    <script src="js/network.js"></script>\n    <script src="js/menu.js"></script>\n    <script src="js/sandustrymp.js"></script>\n';
  const withoutOldScripts = contents
    .replace(/\s*<script src="js\/localisation\.js"><\/script>/g, '')
    .replace(/\s*<script src="js\/state\.js"><\/script>/g, '')
    .replace(/\s*<script src="js\/network\.js"><\/script>/g, '')
    .replace(/\s*<script src="js\/menu\.js"><\/script>/g, '')
    .replace(/\s*<script src="js\/sandustrymp\.js"><\/script>/g, '');
  contents = withoutOldScripts.replace('<script type="module" src="js/bundle.js"></script>',
    requiredScripts + '    <script type="module" src="js/bundle.js"></script>');
  if (!contents.includes('js/localisation.js') || !contents.includes('js/state.js') || !contents.includes('js/network.js') || !contents.includes('js/menu.js') || !contents.includes('js/sandustrymp.js')) {
    console.error('ERROR: anchor not found in index.html'); process.exit(1);
  }
  if (contents !== readTextFile(filePath)) {
    writeTextFile(filePath, contents);
    recordAppliedChange('index.html: renderer module script tags');
  } else recordSkippedChange('index.html');
}

// 3. bundle.js - hooks (multi-version: tries variants with patches.json)
{
  const filePath = path.join(appPath, 'dist/js/bundle.js');
  const patchDefinitions = JSON.parse(readTextFile(path.join(sourceDirectory, 'patches.json')));
  let contents = readTextFile(filePath);
  let dirty = false;
  let criticalFail = false;
  for (const patchDefinition of patchDefinitions.bundle) {
    let applied = false, already = false;
    for (const variant of patchDefinition.variants) {
      if (contents.includes(variant.patched)) { already = true; break; }
      const count = contents.split(variant.anchor).length - 1;
      if (count === 0) continue;
      if (count !== 1) { console.error('ERROR: variant "' + patchDefinition.name + '" occurrences=' + count); continue; }
      contents = contents.replace(variant.anchor, variant.patched);
      applied = true; dirty = true;
      break;
    }
    if (applied) recordAppliedChange('bundle.js: ' + patchDefinition.name);
    else if (already) recordSkippedChange('bundle.js ' + patchDefinition.name);
    else if (patchDefinition.critical) { console.error('  [X] Critical hook "' + patchDefinition.name + '" does not match this game build'); criticalFail = true; }
    else console.warn('  [!] Skipped; feature unavailable on this build: ' + patchDefinition.name);
  }
  if (dirty) writeTextFile(filePath, contents);
  if (criticalFail) { console.error('ERROR: unsupported game version. Supported versions: ' + patchDefinitions.supportedVersions.join(', ')); process.exit(1); }
}

// 4. preload.js - networking bridge
{
  const filePath = path.join(appPath, 'preload.js');
  let contents = readTextFile(filePath);
  if (contents.includes('sandustrympNet')) recordSkippedChange('preload.js');
  else {
    contents += '\n' + readTextFile(path.join(sourceDirectory, 'smp-preload-append.js'));
    writeTextFile(filePath, contents);
    recordAppliedChange('preload.js: sandustrympNet bridge');
  }
}

// 4b. simulation-worker.js - deterministic per-tick random stream
{
  const workerPath = path.join(appPath, 'dist/js/simulation-worker.js');
  if (!fs.existsSync(workerPath)) { console.error('ERROR: simulation-worker.js not found'); process.exit(1); }
  patchSimulationWorker(workerPath);
  recordAppliedChange('simulation-worker.js: deterministic RNG bootstrap');
}

// 5. main.js - networking initialization (block between markers, replaced with each patch)
{
  const filePath = path.join(appPath, 'main.js');
  let contents = readTextFile(filePath);
  const MARK_A = '// --- SandustryMP init ---';
  const MARK_B = '// --- /SandustryMP init ---';
  const block = `\n\n${MARK_A}\ntry {\n  const userDataArgument = process.argv.find((argument) => argument.startsWith('--smp-userdata='));\n  if (userDataArgument) { app.setPath('userData', userDataArgument.split('=')[1]); console.log('[SandustryMP] userData override:', userDataArgument.split('=')[1]); }\n} catch (e) { console.error('[SandustryMP] userdata error:', e); }\ntry {\n  app.whenReady().then(() => {\n    try { require('./smp-main.js').init({ getMainWindow: () => mainWindow }); }\n    catch (e) { console.error('[SandustryMP] init error:', e); }\n  });\n} catch (e) { console.error('[SandustryMP] bootstrap error:', e); }\n${MARK_B}\n`;
  const blockStart = contents.indexOf(MARK_A);
  if (blockStart !== -1) {
    const blockEnd = contents.indexOf(MARK_B);
    contents = contents.slice(0, blockStart).replace(/\n+$/, '') + contents.slice(blockEnd + MARK_B.length);
  }
  // also remove the old v1 block without markers
  contents = contents.replace(/\n\/\/ --- SandustryMP init \(appended by patch\.js\) ---[\s\S]*?\/\/ --- \/SandustryMP ---\n/, '\n');
  contents += block;
  writeTextFile(filePath, contents);
  recordAppliedChange('main.js: init block');
}

// 6. main.js - bypass the single-instance lock in test mode (`--smp-*`)
{
  const filePath = path.join(appPath, 'main.js');
  let contents = readTextFile(filePath);
  const anchor = 'const gotTheLock = app.requestSingleInstanceLock();';
  const patched = "const gotTheLock = process.argv.some((a) => a.startsWith('--smp-')) ? true : app.requestSingleInstanceLock();";
  if (contents.includes(patched)) recordSkippedChange('main.js single-instance bypass');
  else if (contents.includes(anchor)) { contents = contents.replace(anchor, patched); writeTextFile(filePath, contents); recordAppliedChange('main.js: single-instance bypass'); }
  else { console.error('ERROR: single-instance anchor not found'); process.exit(1); }
}

console.log('Done. Changes:', changes);
