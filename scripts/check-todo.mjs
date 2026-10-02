/**
 * 公開前チェック：未確認情報のプレースホルダが本番ビルドに残っていないか検査する。
 *
 * 平成院サイトでは「確認できない事実を推測で書かない」ことを最優先ルールとしている。
 * 未確認の箇所は本文中に {{TODO:...}} と書いておき、このスクリプトが
 * dist/ に残っていればビルドを失敗させる。
 *
 * 使い方: npm run build （build の最後に自動実行される）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const MARKER = '{{TODO';
const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (/\.(html|xml|txt|json)$/.test(entry)) {
      const text = readFileSync(full, 'utf8');
      if (text.includes(MARKER)) {
        text.split('\n').forEach((line, i) => {
          if (line.includes(MARKER)) {
            hits.push(`${full}:${i + 1}  ${line.trim().slice(0, 160)}`);
          }
        });
      }
    }
  }
}

try {
  walk(DIST);
} catch {
  console.error(`[check:todo] ${DIST}/ が見つかりません。先に astro build を実行してください。`);
  process.exit(1);
}

if (hits.length > 0) {
  console.error('\n[check:todo] 未確認プレースホルダが公開ファイルに残っています:\n');
  hits.forEach((h) => console.error('  ' + h));
  console.error('\n事実を確認して置き換えるか、その記述自体を削除してください。推測で埋めないこと。\n');
  process.exit(1);
}

console.log('[check:todo] OK — 未確認プレースホルダはありません。');
