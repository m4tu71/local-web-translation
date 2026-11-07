import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

function fail(message) {
  console.error(`Pages build check failed: ${message}`);
  process.exitCode = 1;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    if (entry.isFile()) return [path];
    throw new Error(`build output must not contain symbolic links: ${path}`);
  }));
  return nested.flat();
}

async function sha256(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

async function verifyBuildOutput(outputPath) {
  const outputDirectory = resolve(outputPath);
  const files = await listFiles(outputDirectory);
  const relativeFiles = files.map(path => relative(outputDirectory, path));
  const fileSet = new Set(relativeFiles);

  for (const requiredFile of ['index.html', 'THIRD_PARTY_NOTICES.txt']) {
    if (!fileSet.has(requiredFile)) fail(`dist is missing ${requiredFile}`);
  }

  const expectedWasmPaths = [
    'node_modules/@wllama/wllama/esm/wasm/wllama.wasm',
    'node_modules/@wllama/wllama-compat/wasm/wllama.wasm',
  ];
  const expectedWasmHashes = new Set(await Promise.all(expectedWasmPaths.map(sha256)));
  const wasmFiles = files.filter(path => path.endsWith('.wasm'));

  if (wasmFiles.length !== expectedWasmHashes.size) {
    fail(`expected ${expectedWasmHashes.size} WASM files, found ${wasmFiles.length}`);
  }

  const actualWasmHashes = new Set(await Promise.all(wasmFiles.map(sha256)));
  for (const expectedHash of expectedWasmHashes) {
    if (!actualWasmHashes.has(expectedHash)) fail(`WASM hash ${expectedHash} does not match the installed package`);
  }

  const indexPath = join(outputDirectory, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const assetReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  const expectedBasePath = '/local-web-translation/';
  const expectedAssetPrefix = '/local-web-translation/assets/';
  const localReferences = assetReferences.filter(reference => reference.startsWith('/') && !reference.startsWith('//'));

  const localJsFiles = [];
  const localCssFiles = [];
  for (const reference of localReferences) {
    if (reference.startsWith(expectedAssetPrefix)) {
      const emittedPath = join(outputDirectory, reference.slice(expectedBasePath.length));
      if (!fileSet.has(relative(outputDirectory, emittedPath))) {
        fail(`index.html references a missing build asset: ${reference}`);
      }
      if (reference.endsWith('.js')) localJsFiles.push(reference);
      if (reference.endsWith('.css')) localCssFiles.push(reference);
      continue;
    }

    if (reference === `${expectedBasePath}THIRD_PARTY_NOTICES.txt`) continue;
    fail(`local reference does not use the configured Pages base path: ${reference}`);
  }

  if (!localJsFiles.length) fail(`index.html does not reference JavaScript below ${expectedAssetPrefix}`);
  if (!localCssFiles.length) fail(`index.html does not reference CSS below ${expectedAssetPrefix}`);
  if (!fileSet.has('THIRD_PARTY_NOTICES.txt') ||
      !assetReferences.includes(`${expectedBasePath}THIRD_PARTY_NOTICES.txt`)) {
    fail('index.html does not link to the included third-party notices using the Pages base path');
  }

  const modelFile = relativeFiles.find(path => /\.(gguf|safetensors|pt|pth|bin|onnx|tgz)$/i.test(path));
  if (modelFile) fail(`build output must not contain model weights or package archives: ${modelFile}`);

  if (process.exitCode) return;
  console.log(`Verified ${files.length} files in ${outputDirectory}; Pages base path, notices, and both WASM hashes are valid.`);
}

const outputPath = process.argv[2] ?? 'dist';
await verifyBuildOutput(outputPath);
