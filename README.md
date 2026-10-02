# 青松山 平成院 植樹葬霊園 公式サイト

岩手県九戸郡洋野町にある「青松山 平成院 植樹葬霊園」の公式サイトです。
Astro による静的サイトで、公開先は Cloudflare Pages を予定しています。

- 本番ドメイン（予定）: https://shokuju-reien.jp/
- 管理者: 宗教法人 青松山 平成院

## 編集する前に

**必ず [`CLAUDE.md`](./CLAUDE.md) を読んでください。**
このサイトには「確認できていないことを推測で書かない」という最優先ルールがあります。
未確認事項は [`docs/TODO.md`](./docs/TODO.md) にまとまっています。

## よくある更新

| やりたいこと | 編集するファイル |
|---|---|
| 料金を変える | `src/data/plans.json` |
| よくあるご質問を足す | `src/data/faq.json` |
| 花木を足す | `src/data/trees.json` |
| 住所・電話を変える | `src/data/site.json` |
| 写真を入れる | `src/images/` に置いて `src/data/images.json` の `file` を書く |
| 色や文字を変える | `src/styles/global.css` の `:root` |

## コマンド

```bash
npm install       # 初回のみ
npm run dev       # 開発サーバー（http://localhost:4321）
npm run build     # 本番ビルド + 未確認プレースホルダの検査
npm run preview   # ビルド結果の確認
```

`npm run build` は、本文に `{{TODO:...}}` が残っていると**失敗します**。
これは未確認情報を誤って公開しないための仕組みです。

## 構成

- Astro 5（静的生成）／プレーンCSS／JavaScript は最小限
- Webフォントなし・JSバンドルなし（インラインの小さなスクリプトのみ）
- React / Next.js / Tailwind / GSAP / Lenis は使っていません
