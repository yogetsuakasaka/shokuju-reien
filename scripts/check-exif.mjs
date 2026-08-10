/**
 * 公開前チェック：Git管理下の画像に EXIF が残っていないか検査する。
 *
 * このサイトのリポジトリは公開されています。
 * 写真の EXIF には GPS 座標・撮影日時・機材情報が入っていることがあり、
 * それをそのままコミットすると誰でも取得できる状態になります。
 *
 * iPhone から画像をアップロードするときは、共有時に「位置情報を含めない」を
 * 選んでください。外し忘れた場合、このスクリプトがビルドを止めます。
 *
 * 使い方: npm run check:exif（npm run build の最後に自動実行される）
 *
 * なお ICC プロファイル（色の情報）は EXIF ではないため、あっても問題ありません。
 * むしろ色を正しく再現するために必要です。
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import sharp from 'sharp';

const IMAGE_RE = /\.(jpe?g|png|webp|avif|tiff?|heic|heif)$/i;

/** リポジトリ容量を守るための上限（超えたら警告のみ） */
const SOFT_LIMITS = {
  bytes: 6 * 1024 * 1024, // 6MB
  longEdge: 4600, // px
};

// 検査対象＝「コミット済み」＋「まだコミットしていないが .gitignore されていない」画像。
// これから push されうるものをすべて見るため。src/images/source/ は
// .gitignore されているので対象外になる。
let tracked;
try {
  tracked = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
    .split('\0')
    .filter(Boolean)
    .filter((f) => IMAGE_RE.test(f));
} catch {
  console.log('[check:exif] Git リポジトリではないため、検査をスキップします。');
  process.exit(0);
}

if (tracked.length === 0) {
  console.log('[check:exif] OK — 検査対象の画像はまだありません。');
  process.exit(0);
}

const withExif = [];
const oversized = [];
const unreadable = [];

for (const file of tracked) {
  let meta;
  try {
    meta = await sharp(file).metadata();
  } catch (e) {
    unreadable.push(`${file}  (${e.message})`);
    continue;
  }

  if (meta.exif && meta.exif.length > 0) {
    withExif.push(`${file}  EXIF ${meta.exif.length} バイト`);
  }

  const bytes = statSync(file).size;
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (bytes > SOFT_LIMITS.bytes || longEdge > SOFT_LIMITS.longEdge) {
    oversized.push(
      `${file}  ${meta.width}x${meta.height}  ${(bytes / 1024 / 1024).toFixed(1)}MB`
    );
  }
}

if (unreadable.length) {
  console.warn('\n[check:exif] 読み取れなかった画像:');
  unreadable.forEach((f) => console.warn('  ' + f));
}

if (oversized.length) {
  console.warn(
    `\n[check:exif] 大きすぎる画像（長辺${SOFT_LIMITS.longEdge}px / ${SOFT_LIMITS.bytes / 1024 / 1024}MB 超）:`
  );
  oversized.forEach((f) => console.warn('  ' + f));
  console.warn(
    '  リポジトリは一度コミットすると履歴から消せません。作業用は長辺3000px程度（Hero候補のみ4000px）にしてください。\n'
  );
}

if (withExif.length > 0) {
  console.error('\n[check:exif] EXIF が残っている画像があります:\n');
  withExif.forEach((f) => console.error('  ' + f));
  console.error(`
このリポジトリは公開されています。EXIF には GPS 座標が含まれている場合があります。

直し方
  1. iPhone：写真アプリで共有 →「オプション」→「位置情報」をオフ → ファイルに保存
     Android：共有 →「位置情報を削除」
  2. 外した画像で、該当ファイルを差し替えてコミットし直す

※ 表示用画像（src/images/ の hero/ story/ seasons/ など）は npm run images が
   生成するため、通常 EXIF は付きません。ここに出た場合は、生成を経ずに
   手で置かれた可能性があります。
`);
  process.exit(1);
}

console.log(`[check:exif] OK — 画像 ${tracked.length} 件、EXIF の残存はありません。`);
