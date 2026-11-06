# wllama の自前ビルド手順

状態: 固定コミットの公式スクリプトを確認して作成した手順。**この環境では未実行**。
WSL・Docker の準備状況、ビルド成功、ブラウザでのロード・翻訳成功は未確認。
この手順ではモデルをダウンロードせず、npm への公開も行わない。

## 1. 対象と成果物

| 対象 | 固定する値 |
| --- | --- |
| wllama | c10c21114984e37fe6ba4edbba446c28c5b7a954 |
| package.json の版表記 | 3.12.0（開発ソースの表記） |
| llama.cpp submodule | d38bea34227bbf9069d62fdc239c98ab6e05435a |
| Emscripten Docker イメージ | emscripten/emsdk:4.0.20（x86_64 を想定） |
| Dawn | v20260317.182325 |
| ホスト Node.js / npm | 22.23.4 / 10.9.10 |

自前ビルドを npm の公式リリース 3.12.0 と区別するため、成果物名にコミットを付ける。
パッケージ内部の name / version は upstream のまま維持する。

```text
vendor/wllama/
├── wllama-3.12.0-c10c211.tgz
├── wllama-compat-3.12.0-c10c211.tgz
└── build-manifest.json
```

ビルドした通常版と compat 版を一組で保存する。アプリの依存としての導入は後述の別工程。
アプリの通常開発・CI はこの tarball を npm ci で復元し、毎回 WASM をコンパイルしない。

## 2. 前提環境

Windows では WSL 2 の Linux シェルから公式の Docker ビルドを実行する。
PowerShell のまま bash スクリプトを実行しない。

準備するもの:

- WSL 2 と Linux ディストリビューション。
- Docker Engine と Compose v2。Docker Desktop を使う場合は対象 WSL との連携。
- WSL 内の Git、Node.js 22.23.4、npm 10.9.10。
- GitHub・npm・Docker レジストリ・Linux パッケージ配布先へのネットワーク接続。
- C++ / WASM のコンパイル用の空きメモリとディスク。必要量・所要時間は未測定。

事前確認（WSL の bash）:

```bash
git --version
node --version
npm --version
docker version
docker compose version
uname -m
```

Docker は Client の表示だけでなく Server へ接続できることを確認する。
Windows 側に Node.js があっても、WSL 内で Linux 用 Node.js が使えるとは限らない。
`command -v node` と `command -v npm` で WSL 内の実行ファイルを確認する。

このプロジェクトで確認したのは Windows 側の Node.js / npm と wsl.exe の存在まで。
Docker コマンドは Windows の PATH 上では見つかっていない。環境の準備・インストールは
本手順を実行する前に行う。

## 3. ソースを固定する

以下のコマンドは、特記がない限り**同じ WSL bash セッションで順番に実行する**。
`set -euo pipefail` により失敗時はそのシェルの処理が停止する。
再開する場合は変数と作業ディレクトリを設定し直す。

ビルド用ソースは OneDrive / Windows マウント配下を避け、WSL の Linux ファイルシステムに置く。
下記は新しい専用ディレクトリを使う例。既存ディレクトリがあれば停止し、内容を確認する。

```bash
set -euo pipefail

export WLLAMA_COMMIT=c10c21114984e37fe6ba4edbba446c28c5b7a954
export LLAMA_CPP_COMMIT=d38bea34227bbf9069d62fdc239c98ab6e05435a
export WLLAMA_BUILD_ROOT="$HOME/build/local-web-translation-wllama-c10c211"

test ! -e "$WLLAMA_BUILD_ROOT"
mkdir -p "$WLLAMA_BUILD_ROOT"
cd "$WLLAMA_BUILD_ROOT"
git clone --no-checkout https://github.com/ngxson/wllama.git source
cd source
git checkout --detach "$WLLAMA_COMMIT"
git submodule update --init --recursive

test "$(git rev-parse HEAD)" = "$WLLAMA_COMMIT"
test "$(git -C llama.cpp rev-parse HEAD)" = "$LLAMA_CPP_COMMIT"
test "$(node -p "require('./package.json').version")" = 3.12.0
git submodule status --recursive
```

`git submodule update --remote` は使わない。ブランチの先端へ更新せず、親コミットが指定する版を使う。

## 4. 依存関係を復元して WASM をビルドする

```bash
test "$(node --version)" = v22.23.4
test "$(npm --version)" = 10.9.10
test "$(uname -m)" = x86_64

# ブラウザの自動インストールは不要。ブラウザテストもこの手順では実行しない。
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm ci

# 通常版・compat 版の両方を作る。デバッグ用 backend ops は含めない。
unset SKIP_COMPAT
unset WLLAMA_TEST_BACKEND
npm run build:wasm 2>&1 | tee "$WLLAMA_BUILD_ROOT/build-wasm.log"

test -s src/wasm/wllama.js
test -s src/wasm/wllama.wasm
test -s compat/wasm/wllama.js
test -s compat/wasm/wllama.wasm
node scripts/check_wasm_version.js
```

公式スクリプトは Docker Compose 内で Emscripten と Dawn を使い、通常版を
WebGPU + JSPI + Memory64、compat 版を WebGPU + Asyncify + wasm32 で構築する。
単一スレッド / マルチスレッド、GPU / CPU の選択は実行時の設定・対応状況で決まる。
別々の CPU 専用パッケージを作る手順ではない。

`npm run build:wasm` は WASM のコンパイル後、GLUE 型と Worker コードも生成する。
版チェックで不一致になった場合は原因を調べ、JS と WASM を同じ固定ソースから作り直す。
`skipVersionCheck` を使って回避しない。

## 5. JavaScript と配布パッケージを生成する

```bash
npm run build 2>&1 | tee "$WLLAMA_BUILD_ROOT/build-js.log"

test -s esm/index.js
test -s esm/index.d.ts
test -s esm/wasm/wllama.wasm
test -s compat/index.js
node scripts/check_wasm_version.js

# compat 側にもライセンス本文を同梱する。
cp LICENCE compat/LICENCE

# デバッグ構成、版整合、パッケージサイズとファイル数を公式スクリプトで検査する。
node scripts/check_package_size.js

mkdir -p "$WLLAMA_BUILD_ROOT/artifacts"
npm pack --dry-run --json > "$WLLAMA_BUILD_ROOT/pack-main.json"
(cd compat && npm pack --dry-run --json) > "$WLLAMA_BUILD_ROOT/pack-compat.json"
```

dry-run のファイル一覧を確認し、以下を満たすことを確かめてから次へ進む。

- 通常版に ESM エントリー、型定義、`esm/wasm/wllama.wasm`、ライセンスが含まれる。
- compat 版に `index.js`、`wasm/wllama.js`、`wasm/wllama.wasm`、ライセンスが含まれる。
- GGUF・モデル重み、ビルド途中のディレクトリ、不要な調査ファイルを含まない。
- パッケージ名は通常版が `@wllama/wllama`、compat 版が `@wllama/wllama-compat`、版表記は双方 `3.12.0`。

```bash
test ! -e "$WLLAMA_BUILD_ROOT/artifacts/wllama-wllama-3.12.0.tgz"
test ! -e "$WLLAMA_BUILD_ROOT/artifacts/wllama-wllama-compat-3.12.0.tgz"
test ! -e "$WLLAMA_BUILD_ROOT/artifacts/wllama-3.12.0-c10c211.tgz"
test ! -e "$WLLAMA_BUILD_ROOT/artifacts/wllama-compat-3.12.0-c10c211.tgz"
npm pack --pack-destination "$WLLAMA_BUILD_ROOT/artifacts"
(cd compat && npm pack --pack-destination "$WLLAMA_BUILD_ROOT/artifacts")

mv "$WLLAMA_BUILD_ROOT/artifacts/wllama-wllama-3.12.0.tgz" \
   "$WLLAMA_BUILD_ROOT/artifacts/wllama-3.12.0-c10c211.tgz"
mv "$WLLAMA_BUILD_ROOT/artifacts/wllama-wllama-compat-3.12.0.tgz" \
   "$WLLAMA_BUILD_ROOT/artifacts/wllama-compat-3.12.0-c10c211.tgz"
```

上記は新規の専用作業ディレクトリを前提とする。再実行時に同名の成果物がある場合は
上書きせず、既存ファイルの退避先または新しい作業ディレクトリを決めてから行う。
`npm run upload` / `npm publish` は実行しない。

## 6. 出自とハッシュを記録する

ソースディレクトリにいる状態で実行する。

```bash
export WLLAMA_DOCKER_VERSION="$(docker version --format '{{.Server.Version}}')"
export WLLAMA_COMPOSE_VERSION="$(docker compose version --short)"

node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const outputDir = join(process.env.WLLAMA_BUILD_ROOT, 'artifacts');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const artifacts = [
  'wllama-3.12.0-c10c211.tgz',
  'wllama-compat-3.12.0-c10c211.tgz',
].map(file => ({ file, sha256: hash(join(outputDir, file)) }));

const manifest = {
  builtAt: new Date().toISOString(),
  wllama: { version: '3.12.0', commit: process.env.WLLAMA_COMMIT },
  llamaCppCommit: process.env.LLAMA_CPP_COMMIT,
  node: process.version,
  npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  docker: process.env.WLLAMA_DOCKER_VERSION,
  compose: process.env.WLLAMA_COMPOSE_VERSION,
  emscriptenImage: 'emscripten/emsdk:4.0.20',
  dawnTag: 'v20260317.182325',
  upstreamLockSha256: hash('package-lock.json'),
  wasm: {
    defaultSha256: hash('esm/wasm/wllama.wasm'),
    compatSha256: hash('compat/wasm/wllama.wasm'),
  },
  artifacts,
  inferenceTested: false,
};
writeFileSync(join(outputDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
NODE

git diff --stat
```

生成コードと compat/package.json などの差分は記録し、意図しないソース変更がないか確認する。
ビルドログ・dry-run 結果も保存する。Docker イメージの解決済み digest、WSL ディストリビューション、
CPU アーキテクチャもビルド記録に残す。
upstream は Docker 内で apt 更新や外部アーカイブ取得を行うため、タグ固定だけで
バイト単位の再現性を保証するものではない。配布する成果物自体のハッシュを確定値とする。

## 7. アプリ側へ成果物を渡す

WSL から Windows のプロジェクトへ tarball と manifest だけをコピーする。
下記は現在の配置例。実行前にアプリの package.json がある場所か確認する。
同名ファイルが存在すれば停止し、上書きしない。

```bash
APP_REPO="$(wslpath 'C:\Users\ryuta\OneDrive\ドキュメント\GitHub\local-web-translation')"
test -f "$APP_REPO/package.json"
test "$(node -p "require(process.argv[1]).name" "$APP_REPO/package.json")" = local-web-translation
mkdir -p "$APP_REPO/vendor/wllama"

for file in wllama-3.12.0-c10c211.tgz wllama-compat-3.12.0-c10c211.tgz build-manifest.json; do
  test ! -e "$APP_REPO/vendor/wllama/$file"
done
for file in wllama-3.12.0-c10c211.tgz wllama-compat-3.12.0-c10c211.tgz build-manifest.json; do
  cp "$WLLAMA_BUILD_ROOT/artifacts/$file" "$APP_REPO/vendor/wllama/$file"
done
```

コピー後に manifest の SHA-256 と一致することを確認する。
ビルド用ソース・中間成果物・Docker データはアプリのリポジトリへ持ち込まない。

## 8. アプリへの導入と検証（ビルド後の別工程）

成果物を確認してから、アプリ側の .gitignore に次の例外を追加する。

```gitignore
!vendor/wllama/wllama-3.12.0-c10c211.tgz
!vendor/wllama/wllama-compat-3.12.0-c10c211.tgz
```

アプリのルートで実行する。以下は Windows PowerShell 用。

```powershell
npm.cmd install --save-exact ./vendor/wllama/wllama-3.12.0-c10c211.tgz ./vendor/wllama/wllama-compat-3.12.0-c10c211.tgz
npm.cmd ci
npm.cmd ls @wllama/wllama @wllama/wllama-compat
```

その後、[導入・切り替え方針](inference-engine-integration.md)に従ってアダプターと
アセット解決を実装する。既存アプリはまだ wllama を呼ばないため、依存を追加しただけでは
モデルの実行確認にならない。

- 通常版 WASM は `@wllama/wllama/esm/wasm/wllama.wasm?url` のように Vite で解決する。
- compat は同じ自前ビルドのパッケージを使用する。公式説明に従い、WASM は `?url`、
  `wasm/wllama.js` は `?raw` で取り込み、`setCompat` に明示的に渡す。
  デフォルトの compat CDN 取得に依存しない。
- JS / Worker / WASM の版チェックを有効なまま維持する。
- package.json、lockfile、tarball、manifest をまとめて Git 管理する。

確認は順に行う。

1. 型検査と本番ビルド。
2. dev / preview の `/local-web-translation/` 配下で JS / WASM を配信できること。
3. 手動 PoC で PLaMo 3 のロード、PFML3 の 1 文翻訳、BOS・停止条件を確認。
4. 同じ入力で GPU と `n_gpu_layers: 0` の CPU を分け、結果・ログ・速度を記録。

ブラウザ操作の自動化は行わない。ビルド・HTTP 配信の成功と、実モデルの推論成功は区別する。
この文書のコマンドはまだ実行しておらず、エラーが出た場合は原因と修正内容を記録する。

## 9. 公式 npm 版へ移行するとき

対応を確認した通常版・compat 版の固定バージョンを dependencies に指定し直す。
アプリ内の import 名は変えず、型検査・アセット解決・手動 PoC を再確認する。
API / アセット構成の差はアダプターとビルド処理で吸収する。
旧 tarball と専用例外の整理は移行検証後に行う。

## 参照した固定ソース

- [公式開発ガイド](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/README-dev.md)
- [WASM ビルド起動](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/scripts/build_wasm.sh)
- [Docker / Emscripten / Dawn の設定](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/scripts/docker-compose.yml)
- [ビルド後のアセット配置](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/scripts/post_build.sh)
- [WASM 版チェック](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/scripts/check_wasm_version.js)
- [パッケージ検査](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/scripts/check_package_size.js)
- [compat と Vite の組み込み例](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/compat/README.md)
