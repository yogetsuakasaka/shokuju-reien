/**
 * 派生画像の生成
 * ==============
 * src/images/work/ に置いた作業用画像から、各スロット用の画像を切り出して書き出します。
 *
 *   npm run images          生成する
 *   npm run images:dry      何が作られるかだけ表示する（ファイルは書きません）
 *   npm run images:apply    生成したうえで images.json の file を自動で紐付ける
 *
 * どこをどう切り出すかは scripts/image-recipes.json に書きます。
 * 詳しい書き方は CLAUDE.md「5. 写真を追加する」を参照してください。
 *
 * 大原則
 *   - 作業用画像は読むだけ。上書きも削除もしません。
 *   - 出力は必ず別ファイルとして src/images/<フォルダ>/ に作ります。
 *   - EXIF（GPS・機材情報など）は出力から自動的に取り除かれます。
 *   - 色味は変えません。sRGB に変換してプロファイルを埋め込むだけです
 *     （iPhone の Display P3 写真からプロファイルを捨てると色がずれるため）。
 *   - 補正は明るさとコントラストのみ。いずれも自然に見える範囲に制限しています。
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC_DIR = 'src/images/work';
const OUT_DIR = 'src/images';
const RECIPES = 'scripts/image-recipes.json';
const IMAGES_JSON = 'src/data/images.json';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const APPLY = args.has('--apply');

const ASPECTS = {
  '9:16': 9 / 16,
  '2:3': 2 / 3,
  '3:4': 3 / 4,
  '4:5': 4 / 5,
  '1:1': 1,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
};

/**
 * 補正の上限。強い HDR・過度な補正をしないための歯止め。
 * この範囲を超える値がレシピに書かれていたら、丸めたうえで警告します。
 *
 * 彩度・色相はここに含めません。色味は変更しない方針です。
 * レシピに saturation を書いても無視され、警告が出ます。
 */
const LIMITS = {
  brightness: [0.94, 1.10],
  contrast: [0.94, 1.12],
};

const clamp = (v, [lo, hi]) => Math.min(Math.max(v, lo), hi);

/** 焦点 (fx, fy) を含む、指定比率の最大矩形を求める。zoom > 1 でさらに寄る。 */
function computeCrop(w, h, ar, fx = 0.5, fy = 0.5, zoom = 1) {
  let cw, ch;
  if (w / h > ar) {
    ch = h;
    cw = ch * ar;
  } else {
    cw = w;
    ch = cw / ar;
  }
  cw = Math.max(1, Math.round(cw / zoom));
  ch = Math.max(1, Math.round(ch / zoom));
  const left = Math.round(Math.min(Math.max(fx * w - cw / 2, 0), w - cw));
  const top = Math.round(Math.min(Math.max(fy * h - ch / 2, 0), h - ch));
  return { left, top, width: cw, height: ch };
}

function fmtKB(bytes) {
  return `${Math.round(bytes / 1024)}KB`;
}

// ---------------------------------------------------------------- 実行
const recipes = JSON.parse(readFileSync(RECIPES, 'utf8'));
const outputs = recipes.outputs ?? [];

if (!existsSync(SRC_DIR)) {
  console.error(`[images] ${SRC_DIR} がありません。作業用画像を置くフォルダを作ってください。`);
  process.exit(1);
}

const results = [];
let made = 0;
let skipped = 0;
let warned = 0;

for (const r of outputs) {
  const label = r.out ?? '(out 未設定)';

  if (!r.source) {
    console.log(`  · ${label.padEnd(34)} 作業用画像が未指定のためスキップ`);
    skipped++;
    continue;
  }

  const srcPath = join(SRC_DIR, r.source);
  if (!existsSync(srcPath)) {
    console.warn(`  ⚠ ${label.padEnd(34)} ${srcPath} が見つかりません。スキップします。`);
    warned++;
    skipped++;
    continue;
  }

  const ar = ASPECTS[r.aspect];
  if (!ar) {
    console.error(`  ✗ ${label}: 未知の比率 "${r.aspect}"（使えるのは ${Object.keys(ASPECTS).join(' / ')}）`);
    process.exitCode = 1;
    continue;
  }

  const pipeline = sharp(srcPath, { failOn: 'error' }).rotate(); // EXIF の向きを反映
  const meta = await pipeline.metadata();
  const crop = computeCrop(meta.width, meta.height, ar, r.fx ?? 0.5, r.fy ?? 0.5, r.zoom ?? 1);

  if (crop.width < r.width) {
    console.warn(
      `  ⚠ ${label.padEnd(34)} 切り出し後 ${crop.width}px < 目標 ${r.width}px（作業用画像の解像度が不足。引き伸ばしはしません）`
    );
    warned++;
  }
  const outW = Math.min(r.width, crop.width);

  if (DRY) {
    console.log(
      `  · ${label.padEnd(34)} ${outW}px 予定  元 ${meta.width}x${meta.height} → 切出 ${crop.width}x${crop.height} @${crop.left},${crop.top}`
    );
    results.push({ ...r, planned: true });
    continue;
  }

  let img = pipeline.extract(crop).resize({ width: outW, withoutEnlargement: true });

  // ---- 軽微な補正（明るさ・コントラストのみ。色味は変えない） ----
  const adj = r.adjust ?? {};
  if (adj.saturation !== undefined || adj.hue !== undefined) {
    console.warn(`  ⚠ ${label}: 彩度・色相の調整は行いません（色味を変更しない方針）。無視します。`);
    warned++;
  }
  const contrast = clamp(adj.contrast ?? 1, LIMITS.contrast);
  const brightness = clamp(adj.brightness ?? 1, LIMITS.brightness);
  for (const [k, v] of Object.entries({ contrast: adj.contrast, brightness: adj.brightness })) {
    if (v !== undefined && v !== clamp(v, LIMITS[k])) {
      console.warn(`  ⚠ ${label}: ${k}=${v} は上限を超えるため ${clamp(v, LIMITS[k])} に丸めました。`);
      warned++;
    }
  }
  if (contrast !== 1) {
    // 中間調を軸にコントラストを調整（RGB を等しく動かすので色相は変わらない）
    img = img.linear(contrast, 128 * (1 - contrast));
  }
  if (brightness !== 1) {
    img = img.modulate({ brightness });
  }
  // 縮小によるにじみを戻すための、ごく弱いシャープ（見た目を変える処理ではない）
  if (r.sharpen !== false) {
    img = img.sharpen({ sigma: 0.6, m1: 0.4, m2: 0.6 });
  }

  const outPath = join(OUT_DIR, r.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const info = await img
    // sRGB へ変換してプロファイルを埋め込む。
    // iPhone の Display P3 写真からプロファイルを捨てると、ブラウザが sRGB として
    // 解釈して色がずれるため。EXIF は付かない（sharp の既定動作）。
    .withIccProfile('srgb')
    .jpeg({ quality: r.quality ?? 86, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(outPath);

  console.log(
    `  ✓ ${label.padEnd(34)} ${info.width}x${info.height}  ${fmtKB(info.size).padStart(6)}  (元 ${meta.width}x${meta.height} → 切出 ${crop.width}x${crop.height} @${crop.left},${crop.top})`
  );
  results.push({ ...r, width: info.width, height: info.height, size: info.size });
  made++;
}

console.log(
  `\n[images] ${DRY ? '確認のみ' : `${made}枚 生成`}${skipped ? ` / ${skipped}枚 スキップ` : ''}${warned ? ` / 警告 ${warned}件` : ''}`
);

// ------------------------------------------------- images.json への紐付け
if (APPLY && !DRY) {
  const data = JSON.parse(readFileSync(IMAGES_JSON, 'utf8'));
  let linked = 0;
  for (const r of results) {
    if (!r.key) continue;
    const entry = data.images[r.key];
    if (!entry) {
      console.warn(`  ⚠ images.json に "${r.key}" がありません。紐付けをスキップします。`);
      continue;
    }
    if (entry.file !== r.out) {
      entry.file = r.out; // alt / want / aspect は触らない
      linked++;
    }
  }
  writeFileSync(IMAGES_JSON, JSON.stringify(data, null, 2) + '\n');
  console.log(`[images] images.json を更新しました（${linked}件の file を設定）`);
}

// --------------------------------------------------------- 未投入の一覧
if (!DRY) {
  const data = JSON.parse(readFileSync(IMAGES_JSON, 'utf8'));
  const pending = Object.entries(data.images)
    .filter(([, v]) => !v.file)
    .map(([k]) => k);
  if (pending.length) {
    console.log(`[images] 写真がまだ入っていないスロット（${pending.length}件）: ${pending.join(', ')}`);
  } else {
    console.log('[images] すべてのスロットに写真が入っています。');
  }
}
