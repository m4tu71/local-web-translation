
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
