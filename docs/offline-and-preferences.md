# オフライン利用と設定の設計

## 目的と境界

利用者がオンライン時に明示して準備した後、アプリ本体と検証済みモデルの両方が残っていれば、ネットワーク接続なしで翻訳画面を起動し、モデルを明示的にロードして翻訳できるようにする。アプリ資産は Service Worker の CacheStorage、モデル重みは既存の OPFS キャッシュに置く。どちらか片方だけでは「オフライン利用の準備完了」と表示しない。

この機能は初回アクセスをオフラインにしない。Service Worker 登録前や必要な資産の初回取得前には通信が必要であり、モデルのロードも利用者が操作する。モデル取得・ロード・翻訳を自動開始しない。入力文、翻訳結果、操作ログ、作業再開用の情報は永続化しない。

保存済みデータはブラウザーや OS により削除される場合がある。`navigator.storage.persist()` は要求しない。OPFS モデルの既定7日、設定可能な最大30日の保持期限と最終使用時刻の規則は[モデルキャッシュ設計](model-cache.md)を引き継ぐ。CacheStorage の準備完了はアプリ資産の保存状態だけを指し、モデルの期限を延長しない。

## 翻訳画面への配置

- 翻訳ワークスペースと常時表示の翻訳状態を主役のまま保つ。既存のモデル設定とは sibling となる独立した `<details id="offline-settings">` を用意し、起動・翻訳のたびに全詳細を展開しない（Progressive Disclosure、H8）。
- 翻訳画面の近くにはオフライン利用状態の短い要約だけを出す。詳細内ではアプリ本体の保存とモデルの保存を別々に示し、利用者がどちらのデータを操作しているか分かるようにする（H1、H6）。
- 翻訳設定の説明と保存状態の通知は翻訳元・翻訳先の言語欄の近くに置く。backend の設定も同じ設定群として見つけられるようにし、言語選択と保存された設定の関係を近接させる。
- 翻訳方向と実行設定を保存するかどうかは「モデルと保存設定」内のチェックボックスで変更できる。既定はオン。オフにすると保存済みの方向と backend を削除し、次回起動時に既定値へ戻す。
- 「オフライン利用の準備」は明示的なボタンとし、オンラインで必要なアプリ資産を取得・検証して保存する。準備完了後もモデルは「モデルをロード」から明示してロードする。
- 翻訳の状態領域にはオフライン可否の簡潔な要約と、翻訳できない理由および復旧操作への導線だけを出す。資産一覧やキャッシュの技術情報は詳細側に置く。
- 操作ボタン、選択欄、開閉要素はタッチ時に最低44×44 pxの操作領域を確保する。ネイティブの `button`、`select`、`details/summary` を使い、キーボード focus を見失わせない。進捗値を細かくライブ通知せず、状態の段階変化だけを `role="status"` で伝える。

## アプリ資産の準備と更新

### 保存対象と整合性

Service Worker の scope は Vite の GitHub Pages base `/local-web-translation/` と一致させる。デプロイされたページの実際の HTML と、そのビルドが参照する JavaScript、CSS、通常版と compat 版の WASM、Worker、第三者ライセンス表示などの notices を同一ビルドの manifest から特定する。アプリ実行時に必要な同一オリジン資産を漏れなく含め、アプリのビルド識別子と資産一覧を一緒に検証する。

Hugging Face 上のモデル URL、モデル本体、部分ダウンロードは Service Worker のアプリ資産キャッシュへ絶対に入れない。モデルは引き続き既存の `ModelCache` が OPFS で検証・管理する。Service Worker の範囲外 URL、opaque response、失敗応答を必要資産として成功扱いしない。

アプリ資産の初回取得・修復には通信が必要だが、準備操作は `navigator.onLine` を根拠に止めない。接続がない場合は実際の取得失敗を表示し、再接続後に再試行できるようにする。新しいビルドの資産を build ID 固有の作業キャッシュへ取得し、対象 URL ごとに成功応答とサイズ・SHA-256 を確認した後、manifest の全項目がそのキャッシュから読めることを検証する。途中失敗・中断は準備完了にせず、未完成キャッシュを削除または再利用不可として扱い、問題資産と復旧方法を示す。現行ビルドのキャッシュが残る場合はその利用を妨げない。

「オフライン利用の準備完了」は少なくとも次のすべてを満たす状態に限る。

1. 現在のページと同じビルドの Service Worker がページを制御している。
2. そのビルドが必要とする全アプリ資産が CacheStorage にあり、完全性検査に合格している。
3. OPFS に保持期限内のモデルがあり、モデル定義に対するサイズと SHA-256 の検証が済んでいる。

メモリ保存モデル、期限切れ、未確認、検証エラー、OPFS 非対応では3を満たさない。アプリ資産だけ準備済みなら「アプリはオフラインで開けます。モデルはこのブラウザーに保存されていません」など、範囲を限定して伝える。

### 起動、接続断、復旧

通常起動では新しい Service Worker の登録を自動開始しない。登録済み worker の状態を確認し、オンライン時はブラウザーに更新確認を依頼する。更新確認により新 worker のインストールとその資産保存が始まる場合はあるが、現在の worker の適用とページ再読み込みは自動化しない。初回は利用者が「オフライン利用を準備」を明示した時に scope に沿った `service-worker.js` を登録し、取得と検証を開始する。初回登録直後はページを制御していないため、入力・結果消失の説明と確認を行ってから再読み込みする。Service Worker 未対応、登録失敗、別 build の controller、CacheStorage 読み込み失敗をそれぞれ識別し、実際のモデル状態と合わせて表示する。起動時に OPFS のモデル検証は自動で行い、「確認中」の間は準備完了と断定しない。モデルロードだけは常に利用者の明示操作とする。オフラインで資産が不足してアプリを動かせない場合は、ネットワークに再接続して公開 URL を再読込するよう案内する。アプリを開けてもモデルが不足・期限切れなら、オンライン再接続後にモデル取得をやり直す導線を示す。

保存したアプリ資産が欠損していて現在の画面を開けない場合は、Service Worker が自己完結の HTTP 503 回復画面を返す。画面は「アプリの保存データに不足があります。通信できる状態で、このアプリの登録を解除してから再読み込みしてください。」と説明し、「アプリの登録を解除して再読み込み」ボタンを提供する。再読み込みで入力・結果は失われるが、保存モデルと翻訳設定は削除しない。

準備済みで接続が切れた場合は、保存済みの同一ビルド資産から画面が開くことを前提にし、ネットワークが必要な操作のみを「接続後に再試行」と案内する。次回起動後もモデル検証は自動、ロードは明示操作とする。更新確認中に新資産が保存される場合があっても、新ビルドの適用とページ再読み込みは手動にする。

### 更新の適用

- Service Worker の更新確認で新資産が保存されることはあるが、自動で controller を切り替えたり現在のページを混在したビルドへ移したり、再読み込みしたりしない。
- 初めて Service Worker がこのページを制御する場合も、入力文と結果が消えることを知らせ、確認してから「保存したアプリで開き直す」または「再読み込みして準備を完了」を実行する。更新適用後も「更新を反映して再読み込み」を明示する。初回の controller 切替や更新は、入力文・未コピーの翻訳結果・undo 内容が再読み込みで失われることを先に知らせ、確認後に実行する。
- 更新は UI から protocol/version・request ID・現在の build ID を付けた `ACTIVATE_UPDATE` メッセージで要求する。Service Worker はその app scope に属する app window client が1つだけの場合に限り要求を受け入れる。複数タブや別 window があれば更新を適用せず、他の app tab/window を閉じてから再試行するよう案内する。
- Service Worker の自動 `skipWaiting()` と `clients.claim()` は使わない。初回 control や更新で controller が変わった後のページ再読み込みは、確認済みの明示操作の一部としてのみ行う。
- `ACTIVATE_UPDATE` は worker が適用直前に再度完全状態を確認する。不足資産があれば更新を拒み、現在の版を利用できる状態を保つ。
- 進行中の資産取得、モデル確認・ロード・削除、翻訳、または中止・解放処理がある間は適用操作を無効にし、理由を近くに表示する。
- 適用前に、再読み込みで入力文・未コピーの翻訳結果・ページ内だけの undo 内容が失われることを具体的に伝え、確認を取る（H3、H5）。作業を自動保存・復元しない。
- `index.html` の `<meta name="offline-build">` でページの hex `buildId` を示す。Vite build 後に生成する `service-worker.js` の manifest は worker 内へ inline し、build ID と最終 HTML を含む各資産の SHA-256 を含める。キャッシュ名は `local-web-translation:${origin}${scope}:${buildId}` の形に固定する。manifest と complete marker はそれぞれ `new URL('__offline__/manifest.json', scopeUrl)` と `new URL('__offline__/complete.json', scopeUrl)` の CacheStorage 内部 key で保持し、通常のページ fetch には公開しない。ページ、Service Worker、manifest、CacheStorage metadata は同じ protocol version と build ID の組で整合を確認する。
- ページと worker 間は protocol version `1`、request ID、request type、ページの build ID、target build ID を要求と応答で照合する。`GET_STATUS` は target build ID を null とし、`STATUS` に worker の build ID、`complete`、`resourceCount`、`totalBytes`、任意の `missing` を返す。状態確認は build ID が一致する manifest と `verified` complete marker、および manifest の全 cache entry がある場合に限り complete とする。欠損・不完全な既存 cache は `PREPARE_APP_CACHE` で修復し、修復要求の target build ID は worker 自身の build ID と一致させる。ページの build ID が異なる場合も app scope と protocol envelope が有効なら修復を要求できるが、修復後に自動 activate / reload はしない。更新と削除の要求は `ACTIVATE_UPDATE`、`CLEAR_APP_CACHE` を送り、worker は同一 request の `RESULT`、`ok` と必要な `reason` を返す。
- 新ビルドは build ID 固有のキャッシュ名で完成まで隔離し、完全検証後にだけ有効化する。既存ページが参照している資産を新ビルドで上書きしない。新しい worker が有効化された後もしばらくは旧 build の cache と旧 manifest の allowlist を保持し、現在のページが要求する旧 hashed asset を旧 cache から返す。更新後は新しい HTML/controller と manifest が同一 build であることを確認してから準備状態を再評価する。
- 古い資産キャッシュの削除は Service Worker activate 時に同じ scope の app window client が0件である場合だけ行う。client が残る場合は旧 build の cache を保持し、該当タブがすべて閉じられるまで削除を延期する。

### 状態と文言

| 状態 | 翻訳画面での表示 | 復旧・次の操作 |
|---|---|---|
| 状態確認中 | 「ブラウザーとモデルの保存状態を確認しています。」 | 検証が終わるまで準備完了と表示しない |
| 起動時に必要資産が欠損 | 503 画面に「アプリの保存データに不足があります。通信できる状態で、このアプリの登録を解除してから再読み込みしてください。」と表示 | 「アプリの登録を解除して再読み込み」。入力と結果は失われるが、モデルと設定は残る |
| 非対応・登録失敗 | 原因を特定したエラー。開発サーバーでは「開発用ページではオフライン保存を利用できません。公開版を開いてください。」 | 公開版を開くか、接続後に再試行 |
| アプリ資産が未保存 | 「このアプリの保存データはまだありません。接続できるときに『オフライン利用を準備』を選んでください。」 | アプリ資産の取得・修復を開始。接続状態の表示だけでは操作を禁止しない |
| 資産取得中 | 「このアプリの保存データを保存しています。」 | 完了またはエラーを待つ。進捗値を細かく読み上げない |
| 部分準備・取得失敗 | エラーと接続を確認して再試行する復旧案内 | 不足資産の取得・修復を再試行 |
| メモリのみのモデル | 「モデルはこのページのメモリだけにあります。再読み込み後も使うには、オンラインでブラウザー保存を選んで取得してください。」 | ブラウザー保存を選んでモデルを取得 |
| モデル未保存・期限切れ | 「モデルがブラウザーに保存されていません。モデル設定から取得してください。」または「保存モデルの保持期限が切れています。モデル設定から再取得してください。」 | モデルを取得。期限が切れたモデルは再利用しない |
| モデル状態の確認失敗 | 「モデルの保存状態を確認できません。モデル設定を開いて状態を確認してください。」 | モデル設定から状態を確認し、必要なら再取得 |
| アプリ資産の状態確認失敗 | 「アプリ本体の保存状態を確認できません。」 | 再試行。現在の版を使える場合は続けて利用 |
| アプリ資産のみ保存済み | 「モデルがブラウザーに保存されていません。モデル設定から取得してください。」 | モデルを取得し、両方の状態を確認 |
| オフライン利用の準備完了 | 「オフライン利用の準備が完了しています。このアプリの保存データと期限内のモデルを確認しました。」 | 翻訳前に「モデルをロード」を明示的に実行 |
| 更新あり | 「新しいアプリ版があります。」 | 処理が終わった後、再読み込みの影響を確認して明示適用 |
| オフライン中に準備不足 | 「ブラウザーはオフラインと表示しています。」と既存の不足理由を表示 | 接続復帰後に不足しているデータだけ再取得 |

準備操作の開始・検証・完了・失敗は `role="status"` で段階ごとに通知する。更新確認のような低優先度情報は live region に繰り返し出さず、画面内の状態とボタンで見つけられるようにする（H1、H6）。エラーは「何が起きたか」「利用者が次にできること」を一緒に示す（H9）。

### アプリ資産キャッシュの削除

アプリ資産の削除と OPFS モデルの削除は別操作として見せ、対象と結果を明示する。実装では、削除操作を protocol/version・request ID・build ID を含む `CLEAR_APP_CACHE` として送り、同 app scope の window client が1つだけであり、かつ資産取得・モデル確認/ロード/削除・翻訳・中止/解放など busy 状態でない場合にだけ許可する。複数 app tab/window があれば他を閉じるよう案内する。UI で削除を確認してから実行する（H3、H5）。

削除処理では own scope の Service Worker registration を解除し、アプリ専用 cache prefix に一致する cache のみを削除する。OPFS モデルと localStorage の利用者設定・保持期間は残す。削除後はアプリ資産の状態を「未保存」とし、オンラインで再準備する案内を出す。ブラウザーのサイトデータ消去でアプリ資産とモデルの両方が消える場合があることも案内する。

## 翻訳設定の保存

保存対象は翻訳設定の保存をオンにした場合の、翻訳元・翻訳先の言語方向と推論 backend の要求値だけ。チェックボックスは既定オン。初期値は既存 UI に合わせて日本語 → 英語、`auto`。backend は `auto` または `cpu`。設定値は再読み込み後の初期選択として使うもので、ロード済みモデルの実行状態を示すものではない。

- `local-web-translation:translation-preferences:v1` という単一 `localStorage` 項目に version 2 の有効 record `{ version: 2, enabled: true, sourceLanguage, targetLanguage, requestedBackend }` または無効 record `{ version: 2, enabled: false }` を保存する。無効 record に翻訳設定は含めない。既存の version 1 は保存オンとして読み取る。方向は日本語 → 英語または英語 → 日本語の対向のみ有効。
- 初期化時は JSON 形式、version、各列挙値、方向の組合せを検証する。不正・欠落・将来の未知版は安全な既定値に戻し、保存失敗もアプリ起動や翻訳を妨げない非ブロッキング警告にする。オフ切替に失敗した場合は、このページでは保存を止め、保存済み設定の削除やオフ設定の次回保持ができない可能性を知らせる。部分的に信用できる値を推測して採用しない。
- `localStorage` の読み書き・JSON parse の例外を捕捉する。保存が利用できない場合は、このページ内で選んだ設定を利用できるが、再読み込み後には保持されないと知らせる。
- この画面は `storage` イベントを購読しない。別タブから値が変わっても、開いているタブの選択・ロード済みモデル・進行中の操作は変えず、新しい設定は次回起動時に反映する。
- 入力文、翻訳結果、undo 用の消去前入力、詳細ログ、ロード状態、model cache の内容はこの設定に含めない。翻訳のたびに「引き継いで再開」もしない。
- 設定の保存・復元が失敗してもモデルの取得、ロード、翻訳は継続できる。説明は状態に応じて一度だけ控えめに出し、通常の翻訳操作を妨げない。

## 実装契約と責務

Service Worker と CacheStorage は同一ビルドのアプリ資産だけを管理し、OPFS のモデルキャッシュ API とは独立させる。オフライン準備状態は「controller/build の整合性」「必要アセットの完全性」「モデルの検証済み状態」を組み合わせて導出し、単一の成功フラグを永続化して真実として扱わない。オンライン時に manifest や取得元を確認できない場合に、古い成功フラグを準備完了として流用しない。

ブラウザーの navigator 接続状態だけを証拠として扱わず、各資産の実際の保存・検証結果を状態に反映する。進捗 observer や UI 表示の失敗が資産取得・推論処理を中断しないようにする。設定保存と model-cache の既存 retention 設定はキーと責務を混ぜない。翻訳設定の読み書き・既定値・validation は `src/storage/translation-preferences.ts`、翻訳画面との接続は `src/ui/translation.ts` が担当し、`tests/translation-preferences.test.mjs` が保存層の検証を担当する。

| ファイル | 責務 |
|---|---|
| `vite.config.ts` | `writeBundle` で書込済み `dist/` 資産を読み、HTML の build ID と最終資産ハッシュを含む inline manifest を `service-worker.js` に生成 |
| `src/offline/client.ts` | 起動時の既存 registration 確認、明示準備、更新適用、app cache 削除、window 間の保護 |
| `src/offline/service-worker.js` | build 固有の CacheStorage、asset 検証、部分準備からの復旧、ナビゲーションと旧 hashed asset の応答 |
| `src/ui/offline.ts` | offline / model / translation 状態を合わせた表示、busy 条件、更新と削除の確認・復旧操作 |
| `scripts/verify-pages-build.mjs` | GitHub Pages の `dist/` にある HTML、base path、inline manifest と資産 SHA-256、notices、両 WASM、モデル禁止資産の確認 |
| `tests/offline-build.test.mjs` / `tests/offline-worker.test.mjs` | manifest/build ID の生成と Service Worker の cache・protocol 状態を Node の mock 環境で確認 |
| `tests/offline-client.test.mjs` | Service Worker の状態読取・request envelope・更新修復・client 間保護を mock 環境で確認 |
| `tests/offline-ui.test.mjs` | オフライン準備条件、busy 状態の操作制限、確認後の再読み込み・削除を mock client で確認 |
| `tests/ui-document.test.mjs` | UI が参照する ID と HTML の ARIA 参照が実文書に存在し、一意であることを確認 |
| `tests/translation-preferences.test.mjs` | 翻訳設定の有効化・無効化、旧版読取、不正 JSON・schema と localStorage 例外を確認 |

## 確認項目と未確認範囲

- `npm test` は Node mock / VM で build manifest、asset cache の準備・修復・更新・削除と protocol、offline client/UI の状態・操作、および設定保存・復元・不正値・localStorage 例外を検証する。翻訳 UI 自体は `storage` イベントを購読しないため、別タブによる設定更新で現在の作業を変えない。
- `npm run build` の後に `node scripts/verify-pages-build.mjs dist` を実行し、GitHub Pages の base 配下から必要資産が参照でき、モデル重みが `dist/` と Service Worker manifest に混入しないことを確認する。Node mock や静的 HTTP の結果はブラウザーの offline 動作を示す証拠にしない。
- この作業ではブラウザー自動化を行わない。実ブラウザーでの offline 起動、更新、他タブ保護、CacheStorage/OPFS 両方を使ったモデルロードと翻訳は、利用者による手動確認が終わるまで未確認と明記する。実モデルを offline で推論できたと主張しない。

## 適用する設計原則

H1 により確認中・保存済み・利用可能状態を区別する。H3 と H5 により更新や削除によるページ内結果の喪失を防ぎ、明示確認を設ける。H6 によりアプリ資産とモデルの保存対象、残りの操作を同じ場所で認識できるようにする。H9 によりネットワーク再接続、再取得、再試行といった具体的回復手段を説明する。詳細を段階的に開く Progressive Disclosure で、主タスクである入力と翻訳の視線を遮らない。
