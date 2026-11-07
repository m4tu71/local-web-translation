# GitHub Actions と GitHub Pages

状態: GitHub Pages で公開済み。2026-11-08、PR #2 の commit `897638a` で CI が成功
（[実行記録](https://github.com/m4tu71/local-web-translation/actions/runs/42414764912)）。この結果は当該 commit の検証であり、公開に使われた workflow の実行記録とは別。

## workflow

`.github/workflows/ci.yml` は pull request の main 向け変更と main への push で実行する。Node.js は `.node-version`、npm は `10.9.10` に合わせ、`npm ci`、`npm test`、`npm run build` を実行する。ビルド後の検査で `dist/` のエントリー、第三者ライセンス表示、Pages のベースパス、実際に参照するアセット、インストール済み wllama 通常版・compat 版の WASM ハッシュを確認する。モデル重みやパッケージアーカイブが `dist/` に混入していないことも確認する。

`.github/workflows/deploy-pages.yml` は main への push または main 上での手動実行でビルドし、検査済みの `dist/` だけを GitHub Pages artifact として公開する。pull request から公開ジョブは実行しない。deploy job は build の完了を待ち、Pages 書き込みと OIDC token の権限だけを持つ。workflow 内の Actions は公式リポジトリで確認した commit SHA に固定している。

## Pages の設定と URL

GitHub Pages の公開元設定はリポジトリ側で一度必要。

1. GitHub リポジトリの **Settings → Pages** を開く。
2. **Build and deployment** の **Source** を **GitHub Actions** にする。
3. workflow が main に入った後、main への push または Actions 画面から `Deploy to GitHub Pages` を実行する。
4. workflow の `github-pages` environment に表示される URL と Actions の完了状態を確認する。

公開先は <https://m4tu71.github.io/local-web-translation/>。

2026-11-08、利用者から公開と実ブラウザーでの手動確認完了の報告を受領した。モデル取得、CPU・GPU それぞれのロード・翻訳・ロード解除、ブラウザーを再起動した後もモデルデータが保持されることを確認済み。環境や実行ログなどは[各検証記録](model-cache.md#手動確認の記録)に記載する。

同日、エージェントは公開 URL に HTTP GET し、HTML の HTTP 200 とページタイトルを確認した。この確認は公開ページの応答確認に限り、ブラウザーでの JavaScript 実行、モデル操作、推論を検証したものではない。利用者が実施したモデル操作の確認とは区別する。公開元設定やデプロイ workflow の個別実行 ID は記録していない。

Vite の `base` は `/local-web-translation/` のままにする。ユーザー名サイトや独自ドメインへ公開先を変更するときは、`vite.config.ts` の `base` とビルド検査を一緒に更新する。

## 公開後の確認

自動 workflow は型検査・モックテスト・静的ビルド・artifact の中身を検査する。ブラウザー実行やモデルの取得・推論は行わない。公開後の確認状況は上記の利用者報告と HTTP 応答確認に分けて記録する。次の項目は引き続き追加確認に使う。

- ルート画面、JavaScript、CSS、通常版と compat 版の WASM、第三者ライセンスが想定 URL のサブパスから HTTP 200 で取得できる。
- モデルのライセンスと取得元リンクが開ける。モデル取得とブラウザー再起動後の OPFS 保持、CPU / GPU での翻訳は利用者報告で確認済み。ネットワーク記録による再取得の有無や、実際に使用されたバックエンドの詳細は未確認。
- Firefox 等の compat 経路を対象とする場合は同じ操作を確認する。CI は実ブラウザーの API 対応や推論成功を保証しない。
- ブラウザー開発者ツールでエラー・404・CORS の失敗がないことを確認する。

workflow は COOP / COEP ヘッダーを設定しない。そのためクロスオリジン分離を要求するマルチスレッド WASM 経路が利用できるとは限らない。Service Worker やアプリ全体のオフライン化もこの構成に含まない。モデルを OPFS に保存していても、アプリや推論エンジンの配信にはネットワーク接続が必要な場合がある。

## 参照

- [Vite: GitHub Pages へのデプロイ](https://vite.dev/guide/static-deploy.html#github-pages)
- [GitHub Docs: Custom workflow による GitHub Pages 公開](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
