# GitHub Actions と GitHub Pages

状態: CI と Pages の workflow を追加。2026-11-08、PR #2 の commit `897638a` で CI が成功
（[実行記録](https://github.com/m4tu71/local-web-translation/actions/runs/42414764912)）。この結果は当該 commit の検証であり、後続 commit は個別の実行結果を確認する。
GitHub Pages の有効化、main 上での公開 workflow、公開先の HTTP 確認は未実施。

## workflow

`.github/workflows/ci.yml` は pull request の main 向け変更と main への push で実行する。Node.js は `.node-version`、npm は `10.9.10` に合わせ、`npm ci`、`npm test`、`npm run build` を実行する。ビルド後の検査で `dist/` のエントリー、第三者ライセンス表示、Pages のベースパス、実際に参照するアセット、インストール済み wllama 通常版・compat 版の WASM ハッシュを確認する。モデル重みやパッケージアーカイブが `dist/` に混入していないことも確認する。

`.github/workflows/deploy-pages.yml` は main への push または main 上での手動実行でビルドし、検査済みの `dist/` だけを GitHub Pages artifact として公開する。pull request から公開ジョブは実行しない。deploy job は build の完了を待ち、Pages 書き込みと OIDC token の権限だけを持つ。workflow 内の Actions は公式リポジトリで確認した commit SHA に固定している。

## Pages の設定と URL

GitHub Pages の公開元設定はリポジトリ側で一度必要。

1. GitHub リポジトリの **Settings → Pages** を開く。
2. **Build and deployment** の **Source** を **GitHub Actions** にする。
3. workflow が main に入った後、main への push または Actions 画面から `Deploy to GitHub Pages` を実行する。
4. workflow の `github-pages` environment に表示される URL と Actions の完了状態を確認する。

想定 URL は <https://m4tu71.github.io/local-web-translation/>。現時点では Pages を有効化・公開しておらず、この URL の到達性は未確認。

Vite の `base` は `/local-web-translation/` のままにする。ユーザー名サイトや独自ドメインへ公開先を変更するときは、`vite.config.ts` の `base` とビルド検査を一緒に更新する。

## 公開後の確認

自動 workflow は型検査・モックテスト・静的ビルド・artifact の中身を検査する。ブラウザー実行やモデルの取得・推論は行わない。公開後は HTTPS 上で以下を手動確認し、ブラウザー・バージョンと結果を記録する。

- ルート画面、JavaScript、CSS、通常版と compat 版の WASM、第三者ライセンスが想定 URL のサブパスから HTTP 200 で取得できる。
- モデルのライセンスと取得元リンクが開ける。モデルは明示的な操作後に Hugging Face から取得され、取得・再読み込み後の OPFS 復元・翻訳が使える。実際の GPU / WASM 経路はブラウザーで選択して確認する。
- Firefox 等の compat 経路を対象とする場合は同じ操作を確認する。CI は実ブラウザーの API 対応や推論成功を保証しない。
- ブラウザー開発者ツールでエラー・404・CORS の失敗がないことを確認する。

workflow は COOP / COEP ヘッダーを設定しない。そのためクロスオリジン分離を要求するマルチスレッド WASM 経路が利用できるとは限らない。Service Worker やアプリ全体のオフライン化もこの構成に含まない。モデルを OPFS に保存していても、アプリや推論エンジンの配信にはネットワーク接続が必要な場合がある。

## 参照

- [Vite: GitHub Pages へのデプロイ](https://vite.dev/guide/static-deploy.html#github-pages)
- [GitHub Docs: Custom workflow による GitHub Pages 公開](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
