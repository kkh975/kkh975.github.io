#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SRC_ROOT = process.env.SRC_ROOT || path.join(process.env.HOME, 'Documents/GitHub/my_app');
const DST_ROOT = process.env.DST_ROOT || path.join(process.env.HOME, 'Documents/GitHub/kkh975.github.io');

const APPS = [
  'app_english_grammar',
  'app_english_idiom',
  'app_foreign_writing',
  'app_frash_card_memory',
  'app_hanja_learn',
  'app_habit_manager',
  'app_stuff_manager',
  'app_plan_advisor',
  'app_household_ledger',
  'app_love_advisor',
];

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function copyIfExists(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`[${ts()}] synced ${src} -> ${dst}`);
}

function syncApp(app) {
  const srcDoc = path.join(SRC_ROOT, app, 'doc');
  const dstApp = path.join(DST_ROOT, app);

  copyIfExists(path.join(srcDoc, 'privacy_policy.md'), path.join(dstApp, 'privacy_policy.md'));
  copyIfExists(path.join(srcDoc, 'terms_of_use.md'), path.join(dstApp, 'terms_of_use.md'));

  const intro = path.join(srcDoc, 'introduce.html');
  const index = path.join(srcDoc, 'index.html');
  if (fs.existsSync(intro)) {
    copyIfExists(intro, path.join(dstApp, 'index.html'));
  } else {
    copyIfExists(index, path.join(dstApp, 'index.html'));
  }
}

function syncAll() {
  APPS.forEach(syncApp);
}

let debounceTimer = null;
function scheduleSync() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(syncAll, 200);
}

console.log(`Watching (event-based): ${SRC_ROOT} -> ${DST_ROOT}`);
syncAll();

const watchers = [];
for (const app of APPS) {
  const dir = path.join(SRC_ROOT, app, 'doc');
  if (!fs.existsSync(dir)) continue;

  const watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
    if (!filename) return;
    const f = String(filename);
    if (f === 'privacy_policy.md' || f === 'terms_of_use.md' || f === 'introduce.html' || f === 'index.html') {
      scheduleSync();
    }
  });

  watcher.on('error', (err) => {
    console.error(`[${ts()}] watcher error (${app}): ${err.message}`);
  });

  watchers.push(watcher);
}

process.on('SIGINT', () => {
  watchers.forEach((w) => w.close());
  process.exit(0);
});
process.on('SIGTERM', () => {
  watchers.forEach((w) => w.close());
  process.exit(0);
});
