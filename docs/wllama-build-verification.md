# wllama 成果物の確認結果

確認日: 2026-11-06（日本時間）。利用者が WSL 側でビルドしてコピーした成果物を、
Windows 側で読み取り確認した。パッケージのインストールやブラウザ操作は行っていない。

以下は成果物の静的確認時点の記録。その後の2026-11-07に利用者の1文翻訳成功を確認した。
現在の実行検証の状況は [手動検証結果](translation-poc.md) を参照。
manifest の inferenceTested はビルド時の記録として false のまま保持する。

## 保存した成果物

| ファイル | サイズ | パッケージ |
| --- | --- | --- |
| [通常版](../vendor/wllama/wllama-3.12.0-c10c211.tgz) | 3,428,581 bytes | @wllama/wllama 3.12.0 |
| [compat 版](../vendor/wllama/wllama-compat-3.12.0-c10c211.tgz) | 4,761,309 bytes | @wllama/wllama-compat 3.12.0 |

両 tarball と [build-manifest.json](../vendor/wllama/build-manifest.json) は Git 管理済み。
ファイル名に固定コミットを付けて自前ビルドを識別する。
正確なハッシュ値・ツールチェーン・ビルド日時は manifest を参照する。

## 版と整合性

- manifest の wllama commit: c10c21114984e37fe6ba4edbba446c28c5b7a954。
- manifest の llama.cpp commit: d38bea34227bbf9069d62fdc239c98ab6e05435a。
- 両 tarball の SHA-256 が manifest の artifacts と一致。
- 内包された通常版・compat 版 WASM の SHA-256 が manifest の wasm と一致。
- 通常版 JS と両 WASM に記録された llama.cpp の版は b12162-d38bea3 で一致。
- 同梱 src/wllama.ts が調査時に取得した固定コミットの公式ソースと一致。
- 両 WASM のファイルヘッダーと plamo3 の識別文字列を確認。

manifest はビルド時の申告情報であり、ハッシュの照合はコピーされたファイルとの整合確認。
全ソースからの独立した再ビルドや、実行時の版チェックを行ったものではない。

## パッケージ内容

| 項目 | 通常版 | compat 版 |
| --- | --- | --- |
| 展開後サイズ | 12,063,018 bytes | 18,801,353 bytes |
| ファイル数 | 82 | 6 |
| WASM サイズ | 10,189,070 bytes | 18,623,469 bytes |
| ライセンス本文 | あり | あり |

通常版の ESM / CJS エントリー、型定義、WASM と、compat 版のエントリー、JS、WASM が存在する。
tar ヘッダーのチェックサム・パス・重複エントリーも確認した。
公式のサイズ・ファイル数上限（各 20 MiB / 90 ファイル）内であり、
GGUF・safetensors などのモデル重みやビルド途中のディレクトリは含まれていない。

## 未検証の範囲と次の工程

依存導入、Vite の WASM 配信、WASM の初期化、モデル取得・ロード、PFML3 の翻訳、
WebGPU / WASM CPU の動作・速度・メモリは未検証。manifest の inferenceTested も false。
識別文字列や版の一致だけで推論成功とは判断しない。

準備ブランチの対象は成果物の保存・静的確認まで。
次のブランチで [導入・切り替え方針](inference-engine-integration.md) に従い、
依存導入 → Vite のアセット解決 → 推論アダプター → 手動 1 文翻訳 PoC を進める。
再ビルドが必要になった場合は [自前ビルド手順](wllama-self-build.md) を参照する。
