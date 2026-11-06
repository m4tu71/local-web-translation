# 開発環境の定義

状態: 定義のみ。環境構築・依存関係のインストール・動作検証は未実施。

## 採用構成

| 項目 | 定義 |
| --- | --- |
| UI | 標準 HTML、Vanilla CSS、Vanilla TypeScript |
| フレームワーク | React / Vue などは使用しない |
| ビルドツール | Vite（vanilla-ts 相当の構成） |
| Node.js | 初期基準は 22.23.4。ローカルと将来の CI で同一バージョンを使用 |
| パッケージ管理 | npm。初期基準は 10.9.9 |
| モジュール | ES Modules（package.json の type: module） |
| 最初の開発依存 | vite、typescript、@types/node |
| 最初の実行時依存 | なし。推論エンジンは互換性調査後に追加 |
| 配信 | dist/ の静的ファイルを GitHub Pages へ公開 |

Node.js / npm は現在のローカル環境でバージョンを確認済み。Vite の公式要件は
Node.js 20.19+ または 22.12+。Node.js 22 系を使用する間も保守期限と更新を確認する。
構築時に Vite / TypeScript / @types/node の安定版と相互互換性を確認し、
正確なバージョンを package.json に記載する。package-lock.json を Git 管理し、
以後の再構築・CI は npm ci を使用する。プレリリースは採用しない。

既存リポジトリ内のファイルを維持し、プロジェクト全体の再生成は行わない。

## Vite 設定

構築時に作成する vite.config.ts の初期定義:

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

構築時に定義する npm scripts:

| コマンド | 内容 |
| --- | --- |
| npm run dev | vite |
| npm run typecheck | tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json |
| npm run build | npm run typecheck && vite build |
| npm run preview | vite preview |

Vite 単体では型検査しないため、本番ビルドの前に型検査を必須とする。
ESLint、整形ツール、テストランナーは初期構築の必須依存に含めず、必要な段階で定義する。

## ファイル構成

```text
docs/development-environment.md  # この定義
index.html                       # エントリーポイント
src/main.ts                      # 起動処理
src/styles/                      # CSS
src/ui/                          # DOM 操作
src/inference/                   # 推論エンジンを隔離する境界
src/storage/                     # OPFS と期限管理
public/                          # ビルド時にコピーする静的アセット
vite.config.ts
tsconfig.json
tsconfig.node.json
package.json
package-lock.json
.node-version                    # 採用 Node.js バージョン
dist/                            # ビルド成果物、Git 管理外
.ai/                             # 調査・検証記録、Git 管理外
```

各ディレクトリは必要になった時点で作成する。public/wasm/ はエンジン選定後に検討する。
モデル重みは public/、src/、dist/、Git 管理対象のいずれにも置かず、
Hugging Face からブラウザが直接取得して OPFS に保存する。

## 推論 PoC に向けた保留事項

- wllama などのエンジンとバージョンは、PLaMo 3 GGUF の調査・実行結果で決める。
- WASM アセットの配置、Worker、WebGPU、WASM スレッド数はエンジン要件を確認して定義する。
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

## 参照

- [Vite: Getting Started](https://vite.dev/guide/)
- [Vite: TypeScript](https://vite.dev/guide/features#typescript)
- [Vite: GitHub Pages](https://vite.dev/guide/static-deploy.html#github-pages)
- [Node.js: リリーススケジュール](https://github.com/nodejs/Release)
