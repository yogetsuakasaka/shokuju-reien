# src/images/source/ — 元画像の置き場所（任意・Git管理外）

**通常は使いません。** 写真のアップロード先は `src/images/work/` です。

このフォルダは `.gitignore` で除外されており、**ここに置いた画像は push されません**。
お手元のPCで元画像（撮って出し・RAW現像後の大きいファイル）を保管したいときに、
作業場所として使ってください。

```
src/images/source/*          ← Git 管理外
!src/images/source/README.md ← このファイルだけ管理下
```

---

## 使う場合

PCで元画像から作業用画像を作りたいときの置き場所です。
ここから `src/images/work/` へ、EXIF を外して縮小したものを書き出してから
コミットしてください。

現在の運用（案2）では、**iPhone の共有時に位置情報を外して
`src/images/work/` へ直接アップロードする**ため、このフォルダは空のままで構いません。

詳しくは `src/images/work/README.md` と CLAUDE.md「5. 写真を追加する」を参照してください。
