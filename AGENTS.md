
# 開発エージェントの役割分担

## 親エージェント

あなたは開発全体を統括する。

担当:
- 要件の理解
- コードベースの把握
- 実装方針の決定
- タスク分解
- サブエージェントへの指示
- 実装結果のレビュー
- 最終的な完了判定

## 実装ルール

- コードの作成・編集・修正は原則として
  implementer サブエージェントに委任する。
- 親は原則として直接コードを編集しない。
- 実装前に対象ファイルと完了条件を明確にする。
- 独立したタスクは複数の implementer に
  並列で委任してよい。
- 同一ファイルを複数エージェントに
  同時編集させない。

## 実装後

- 子の完了を待つ。
- 親が変更差分をレビューする。
- 問題があれば子に修正を依頼する。
- テスト結果を確認してから完了を報告する。


# Codex Instructions

## Project
local-web-translation is a static, browser-only
translation application powered by PLaMo 3 Translate.

## Core requirements
- Deploy to GitHub Pages.
- No inference backend or external translation API.
- Download model weights directly from Hugging Face.
- Cache GGUF models in browser OPFS.
- Default cache expiration: 7 days after last use.
- Allow extending the cache duration up to 30 days.
- Do not request persistent browser storage.
- Prefer WebGPU, with WASM fallback where supported.
- Keep model weights outside the Git repository.

## Development
- Use TypeScript and Vite.
- Do not use React, Vue, or other UI frameworks.
- Favor readable control flow, descriptive names, and small functions with clear responsibilities.
- Verify browser engine and model compatibility.
- Never claim inference works without testing it.
- Keep large model files out of the build output.
- Run available checks after changes.
- Keep GitHub Pages base paths compatible.
- Isolate engine-specific imports and APIs inside the inference adapter.
- Keep self-built wllama replaceable by the official npm package; source JS, Worker, and WASM from the same installed build.

## Design
- Use the installed design-skills when relevant.
- Prioritize clarity, responsiveness, and accessibility.
- Provide clear model download and storage controls.
- Communicate loading, errors, and unsupported devices.

## Local workspace
- Use .ai/ for temporary research, plans, and notes.
- .ai/ is Git-ignored and may not exist.
- Do not depend on .ai/ for essential build inputs.
- Keep durable project requirements in tracked files.

## Licensing
- Application source: MIT.
- PLaMo model: separate PLaMo Community License.
- Preserve third-party license notices.
