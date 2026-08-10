/**
 * 公開前チェック：Git管理下の画像に位置情報（GPS）が残っていないか検査する。
 *
 * このサイトのリポジトリは公開されています。
 * 写真の EXIF に GPS 座標が入ったままコミットすると、撮影場所が誰にでも分かります。
 *
 * iPhone から画像をアップロードするときは、共有時に「位置情報を含めない」を
 * 選んでください。外し忘れた場合、このスクリプトがビルドを止めます。
 *
 * 使い方: npm run check:exif（npm run build の最後に自動実行される）
 *
 * 判定の考え方
 *   - GPS 情報がある            → エラー（ビルドを止める）
 *   - GPS 以外の EXIF がある    → 情報表示のみ（止めない）
 *     iPhone や一眼の「位置情報をオフ」で書き出すと、カメラ機種や撮影日時は
 *     残ります。これは公開しても実害がないため、許容します。
 *   - ICC プロファイル（色情報）→ 問題なし。むしろ色を正しく出すために必要。
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

/**
 * EXIF（TIFF構造）から GPS 情報を取り出す。
 * GPS IFD（タグ 0x8825）の有無を見て、あれば緯度経度も読む。
 */
function readGps(buf) {
  try {
    let o = 0;
    if (buf.slice(0, 4).toString('latin1') === 'Exif') o = 6;
    const le = buf.slice(o, o + 2).toString('latin1') === 'II';
    const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
    const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));

    let gpsBase = null;
    const ifd0 = o + u32(o + 4);
    const n = u16(ifd0);
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x8825) gpsBase = o + u32(e + 8);
    }
    if (gpsBase === null) return null;

    const tags = {};
    const gn = u16(gpsBase);
    for (let i = 0; i < gn; i++) {
      const e = gpsBase + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const cnt = u32(e + 4);
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const len = (sizes[type] || 1) * cnt;
      tags[tag] = len <= 4 ? e + 8 : o + u32(e + 8);
    }
    const rat = (p) => u32(p) / u32(p + 4);
    const dms = (p) => rat(p) + rat(p + 8) / 60 + rat(p + 16) / 3600;
    const ref = (t) => (tags[t] ? buf.slice(tags[t], tags[t] + 1).toString('latin1') : '');

    if (tags[2] && tags[4]) {
      return `${dms(tags[2]).toFixed(6)}${ref(1)}, ${dms(tags[4]).toFixed(6)}${ref(3)}`;
    }
    return 'GPSタグあり（座標は読み取れず）';
  } catch {
    return 'GPSの有無を判定できませんでした（要目視確認）';
  }
}

// 検査対象＝「コミット済み」＋「まだコミットしていないが .gitignore されていない」画像。
// これから push されうるものをすべて見る。src/images/source/ は .gitignore 済みなので対象外。
let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .filter((f) => IMAGE_RE.test(f));
} catch {
  console.log('[check:exif] Git リポジトリではないため、検査をスキップします。');
  process.exit(0);
}

if (files.length === 0) {
  console.log('[check:exif] OK — 検査対象の画像はまだありません。');
  process.exit(0);
}

const withGps = [];
const withExif = [];
const oversized = [];
const unreadable = [];

for (const file of files) {
  let meta;
  try {
    meta = await sharp(file).metadata();
  } catch (e) {
    unreadable.push(`${file}  (${e.message})`);
    continue;
  }

  if (meta.exif && meta.exif.length > 0) {
    const gps = readGps(meta.exif);
    if (gps) withGps.push(`${file}\n      → ${gps}`);
    else withExif.push(`${file}  (${meta.exif.length}B・GPSなし)`);
  }

  const bytes = statSync(file).size;
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (bytes > SOFT_LIMITS.bytes || longEdge > SOFT_LIMITS.longEdge) {
    oversized.push(`${file}  ${meta.width}x${meta.height}  ${(bytes / 1024 / 1024).toFixed(1)}MB`);
  }
}

if (unreadable.length) {
  console.warn('\n[check:exif] 読み取れなかった画像:');
  unreadable.forEach((f) => console.warn('  ' + f));
}

if (withExif.length) {
  console.log(
    `[check:exif] GPS以外の EXIF が残っている画像 ${withExif.length} 件（カメラ機種・撮影日時など。公開して差し支えないため許容）:`
  );
  withExif.forEach((f) => console.log('  · ' + f));
}

if (oversized.length) {
  console.warn(
    `\n[check:exif] 大きすぎる画像（長辺${SOFT_LIMITS.longEdge}px または ${SOFT_LIMITS.bytes / 1024 / 1024}MB 超）:`
  );
  oversized.forEach((f) => console.warn('  ' + f));
  console.warn(
    '  Git は一度コミットすると履歴から消せません。次回からは長辺3000px程度\n' +
      '  （Hero候補のみ4000px）に縮小してからアップロードしてください。\n'
  );
}

if (withGps.length > 0) {
  console.error('\n[check:exif] 位置情報（GPS）が残っている画像があります:\n');
  withGps.forEach((f) => console.error('  ' + f));
  console.error(`
このリポジトリは公開されています。GPS 座標から撮影場所が特定できます。

直し方
  1. iPhone：写真アプリで共有 →「オプション」→「位置情報」をオフ → ファイルに保存
     Android：共有 →「位置情報を削除」
  2. 外した画像で該当ファイルを差し替えて、コミットし直す

※ 一度 push すると履歴に残ります。差し替えるだけでは履歴からは消えないため、
   すでに push 済みの場合はご相談ください。
`);
  process.exit(1);
}

console.log(`[check:exif] OK — 画像 ${files.length} 件、位置情報（GPS）の残存はありません。`);
