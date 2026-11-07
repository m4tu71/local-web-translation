# 開発環境の定義

状態: 開発環境を構築済み。依存関係の復元・型検査・ビルド・HTTP 配信を確認済み。
利用者がモデルの取得・メモリからの削除・実モデルのロードと1文翻訳をブラウザで手動確認済み。
利用者が GPU / CPU（WASM）の両経路を確認し、処理時間とログを提供。ブラウザ・端末の詳細は未記録。

## 採用構成

| 項目 | 定義 |
| --- | --- |
| UI | 標準 HTML、Vanilla CSS、Vanilla TypeScript |
| フレームワーク | React / Vue などは使用しない |
| ビルドツール | Vite 8.3.6（vanilla-ts 相当の構成） |
| Node.js | 初期基準は 22.23.4。ローカルと将来の CI で同一バージョンを使用 |
| パッケージ管理 | npm。基準は 10.9.10 |
| モジュール | ES Modules（package.json の type: module） |
| 最初の開発依存 | vite 8.3.6、typescript 7.0.2、@types/node 22.20.5 |
| 現在の実行時依存 | @wllama/wllama・@wllama/wllama-compat 3.12.0（保存済みローカル tarball） |
| モデルのハッシュ検証 | @noble/hashes 2.4.0（ストリームで SHA-256 を計算） |
| 公開先の方針 | dist/ の静的ファイルを GitHub Pages へ公開（未設定） |

Node.js / npm は現在のローカル環境でバージョンを確認済み。Vite の公式要件は
Node.js 20.19+ または 22.12+。Node.js 22 系を使用する間も保守期限と更新を確認する。
構築時に npm レジストリで安定版を確認し、型検査とビルドの成功を確認した。
正確なバージョンを package.json に記載する。package-lock.json を Git 管理し、
以後の再構築・CI は npm ci を使用する。プレリリースは採用しない。

npm は更新を定期確認し、対応する Node.js と変更点を確認した安定版へ更新する。
更新時は Windows・将来の WSL / CI・package.json・手順書の基準を揃え、依存復元・型検査・
本番ビルド・npm audit を確認する。脆弱性対応は npm 本体とアプリの依存関係を分けて確認する。
メジャー更新では npm pack など upstream ビルドスクリプトが使うコマンドの動作差も確認する。

既存リポジトリ内のファイルを維持し、プロジェクト全体の再生成は行わない。

## Vite 設定

vite.config.ts の初期設定:

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/local-web-translation/',
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
```

開発時の URL は http://localhost:5173/local-web-translation/、
ビルド確認用 URL は http://localhost:4173/local-web-translation/ とする。
ブラウザ API の検証は localhost または HTTPS で行う。
public/ 内のファイルを参照するときは import.meta.env.BASE_URL を利用し、
サブパスを無視する絶対パスを避ける。外部モデルの URL は別途管理する。

build.target は初期段階で上書きせず、採用する Vite の既定値を使用する。
ビルド対象ブラウザと WebGPU / WASM / OPFS の利用可否は別途検証する。

## TypeScript とコマンド

アプリ用 tsconfig.json は strict、noEmit、isolatedModules を有効にし、
module: ESNext、moduleResolution: Bundler、target: ES2022、
lib: ES2022 / DOM / DOM.Iterable、types: vite/client を初期値とする。
Vite 設定は Node.js 用 tsconfig.node.json に分け、Node 型を指定する。
Worker を導入するときは DOM と WebWorker の型が衝突しない構成を追加する。

定義済みの npm scripts:

| コマンド | 内容 |
| --- | --- |
| npm run dev | vite |
| npm run typecheck | tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json |
| npm test | Node.js 標準テストランナーで推論 API・モデル取得・表示状態のモックテスト |
| npm run build | npm run typecheck && vite build |
| npm run preview | vite preview |

Vite 単体では型検査しないため、本番ビルドの前に型検査を必須とする。
テストは Node.js の型除去機能を使用する。src/ 内の .ts 拡張子付き import を許可するが、
noEmit は維持し、ブラウザ向けの変換・出力は Vite が行う。
ESLint・整形ツール・外部テストランナーは未導入。

## ファイル構成

```text
docs/development-environment.md  # この定義
index.html                       # エントリーポイント
src/main.ts                      # 起動処理
src/styles/                      # CSS
src/inference/                    # UI 非依存 API、PFML3、wllama アダプター
src/models/                       # 固定モデルの取得・検証・保存方法の選択
src/storage/                      # OPFS キャッシュと保持期限
src/ui/                           # モデル取得の DOM 操作と表示状態
src/poc/                          # 手動翻訳検証の操作フローとログ
tests/                            # 推論 API / wllama クライアントのモックテスト
public/THIRD_PARTY_NOTICES.txt    # 配信に含めるライセンス表示
vendor/wllama/                   # 自前ビルド済み tarball 2 個と manifest
vite.config.ts
tsconfig.json
tsconfig.node.json
package.json
package-lock.json
.node-version                    # 採用 Node.js バージョン
dist/                            # ビルド成果物、Git 管理外
.ai/                             # 調査・検証記録、Git 管理外
```

WASM はインストール済み依存から Vite で解決し、Worker コードは同じ依存から取り込む。
モデル重みは public/、src/、dist/、Git 管理対象のいずれにも置かず、
Hugging Face からブラウザが直接取得して OPFS に保存する。

## 推論 PoC に向けた保留事項

エンジン導入時は [推論エンジンの導入・切り替え方針](inference-engine-integration.md) に従う。
自前ビルドと公式 npm 版を同じパッケージ名で扱い、アダプターとアセット解決を分離する。

- wllama 3.12.0 相当はビルド・保存・静的確認・依存導入・アセット設定済み。
  利用者の環境で GPU / CPU（WASM）のロード・1文翻訳・ロード解除を確認済み。
  最終採用は PLaMo 3 のロード・翻訳結果に基づいて決める。
- WASM / Worker は依存から取り込み済み。WebGPU と WASM スレッド数はモデル操作の実装時に定義する。
- マルチスレッド WASM が要求するクロスオリジン分離は、GitHub Pages での成立条件も検証する。
  開発サーバーだけにヘッダーを追加して公開環境でも動くとは判断しない。
- Service Worker とオフライン対応は初期構築に含めず、推論 PoC 後に設計する。
- GitHub Actions の workflow と Pages 設定はデプロイ段階で追加・確認する。

## 環境構築後の完了条件

1. npm ci で依存関係を復元できる。
2. npm run typecheck と npm run build が成功する。
3. 開発サーバーと preview のサブパスで最小ページを表示でき、アセットが 404 にならない。
4. dist/ にモデル重みが含まれず、推論 API やバックエンドを必要としない。

この完了条件はビルド環境の確認であり、モデルのロード・翻訳成功を意味しない。

## 構築時の確認結果

- npm ci --offline によるローカルキャッシュからの再インストール成功。
- npm run build 成功（アプリと Vite 設定の型検査を含む）。
- 開発サーバーと preview のサブパスで HTML・JavaScript・CSS の HTTP 200 を確認。
- dist/ は HTML・JavaScript・CSS、両版の WASM、第三者ライセンスを含む。モデル重みは含まれない。
- npm 10.9.10 への更新後に依存復元・型検査・ビルドを確認。2026-11-06 の npm audit は既知の脆弱性 0 件。
  この監査は wllama の依存導入前の結果で、自前 tarball 内部のコードは含まれない。
- ブラウザ操作は自動化しない。実行結果は利用者の手動検証に基づく。
- wllama の保存済み成果物は [静的確認済み](wllama-build-verification.md)。
  ローカル tarball から通常版・compat 版の依存導入後、npm ls と型検査・ビルドが成功。
  依存追加後も npm ci --offline で 21 パッケージの復元に成功。
  復元した両 WASM の SHA-256 が manifest と一致し、型検査・ビルドも成功。
  WASM / Worker の読み込み設定と dev / preview のサブパスでの HTTP 配信を確認。
  配信された両 WASM の SHA-256 も manifest と一致。利用者の環境で実モデルのロード・1文翻訳が成功。
  推論 API のロード・翻訳・中止・破棄・状態通知は実装し、モックで検証済み。
  固定モデルの取得・検証・進捗・エラー表示は実装し、小さな模擬データで検証済み。
  利用者が実モデルの取得・メモリからの削除を手動確認済み（詳細はモデル取得文書に記録）。
  ロード・日英翻訳・中止・ロード解除の PoC 画面は実装し、模擬エンジンで検証済み。
  OPFS のキャッシュと保持期限を実装し、模擬 OPFS テストを追加。2026-11-08、利用者から OPFS への保存・復元・推論が動作したとの報告を受領（詳細と未確認範囲は[モデルキャッシュ文書](model-cache.md)）。デプロイは未実装。利用者の GPU / CPU 別の過去の確認結果は翻訳 PoC 文書に記録。

## 参照

- [Vite: Getting Started](https://vite.dev/guide/)
- [Vite: TypeScript](https://vite.dev/guide/features#typescript)
- [Vite: GitHub Pages](https://vite.dev/guide/static-deploy.html#github-pages)
- [Node.js: リリーススケジュール](https://github.com/nodejs/Release)
