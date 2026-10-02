/**
 * OGP画像（SNSでシェアされたときに表示される画像）を作る。
 *
 *   npm run ogp
 *
 * 出力先は public/ogp.jpg です。public/ の中はファイル名が変わらないため、
 * https://shokuju-reien.jp/ogp.jpg で固定のURLになります。
 * （src/images/ に置くとビルドのたびにハッシュ付きの名前になり、OGPには使えません）
 *
 * 1200×630 は OGP の推奨サイズです。SNSのカードは小さく表示されるため、
 * 空と稜線が入る「引き」の写真がいちばん読み取りやすくなります。
 *
 * 切り出し方の考え方は scripts/derive-images.mjs と同じで、
 * 色味は変更せず、明るさ・コントラストのごく軽い調整だけを行います。
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SRC = 'src/images/work/02-drone-wide.JPG';
const OUT = 'public/ogp.jpg';

/** 残したい場所。0=左端／上端、0.5=中央、1=右端／下端 */
const FOCUS = { fx: 0.5, fy: 0.46 };
const SIZE = { width: 1200, height: 630 };
/** ごく軽い調整のみ。彩度・色相は変更しない。 */
const CONTRAST = 1.05;

function computeCrop(w, h, ar, fx, fy) {
  let cw, ch;
  if (w / h > ar) {
    ch = h;
    cw = ch * ar;
  } else {
    cw = w;
    ch = cw / ar;
  }
  cw = Math.round(cw);
  ch = Math.round(ch);
  return {
    left: Math.round(Math.min(Math.max(fx * w - cw / 2, 0), w - cw)),
    top: Math.round(Math.min(Math.max(fy * h - ch / 2, 0), h - ch)),
    width: cw,
    height: ch,
  };
}

const meta = await sharp(SRC).metadata();
const crop = computeCrop(meta.width, meta.height, SIZE.width / SIZE.height, FOCUS.fx, FOCUS.fy);

mkdirSync(path.dirname(OUT), { recursive: true });

const info = await sharp(SRC)
  .rotate()
  .extract(crop)
  .resize(SIZE.width, SIZE.height, { fit: 'cover' })
  .linear(CONTRAST, 128 * (1 - CONTRAST))
  // EXIF は引き継がない（位置情報を公開しないため）。sRGB のプロファイルだけ埋め込む。
  .withIccProfile('srgb')
  .jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:4:4' })
  .toFile(OUT);

console.log(
  `[ogp] ${OUT}  ${info.width}x${info.height}  ${Math.round(info.size / 1024)}KB  (元 ${SRC})`
);
