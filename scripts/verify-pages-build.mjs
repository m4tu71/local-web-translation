import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_BASE_PATH = '/local-web-translation/';
const EXPECTED_WASM_PATHS = [
  'node_modules/@wllama/wllama/esm/wasm/wllama.wasm',
  'node_modules/@wllama/wllama-compat/wasm/wllama.wasm',
];

function fail(message) {
  throw new Error(`Pages build check failed: ${message}`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    if (entry.isFile()) return [path];
    fail(`build output must not contain symbolic links: ${path}`);
  }));
  return nested.flat();
}

async function readBytes(path) {
  try {
    return await readFile(path);
  } catch {
    fail(`required file is missing: ${path}`);
  }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function contentHashedPath(path) {
  return /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path);
}

function parseWorkerManifest(workerSource) {
  const buildId = workerSource.match(/^const BUILD_ID = "([a-f0-9]{64})";$/m)?.[1];
  const basePath = workerSource.match(/^const BASE_PATH = "([^"]+)";$/m)?.[1];
  const manifestSource = workerSource.match(/^const ASSETS = (.+);$/m)?.[1];

  if (!buildId) fail('service-worker.js does not contain a 64-character build id');
  if (!basePath) fail('service-worker.js does not contain a base path');
  if (!manifestSource) fail('service-worker.js does not contain its inline asset manifest');

  let assets;
  try {
    assets = JSON.parse(manifestSource);
  } catch {
    fail('service-worker.js has an invalid inline asset manifest');
  }
  if (!Array.isArray(assets) || !assets.length) fail('service-worker.js asset manifest is empty');
  return { buildId, basePath, assets };
}

function safeOutputFile(outputDirectory, urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    fail(`manifest URL has invalid path encoding: ${urlPath}`);
  }

  const relativePath = decodedPath.replace(/^\//, '').split('/').join(sep);
  const outputPath = resolve(outputDirectory, relativePath);
  const outputPrefix = `${outputDirectory}${sep}`;
  if (!outputPath.startsWith(outputPrefix)) fail(`manifest URL escapes the build output: ${urlPath}`);
  return outputPath;
}

function isAllowedPrecachePath(relativePath) {
  if (relativePath === 'index.html' || relativePath === 'THIRD_PARTY_NOTICES.txt') return true;
  return /\.(?:js|css|wasm|svg|png|jpe?g|webp|ico|woff2?)$/i.test(relativePath);
}

async function verifyBuildOutput(outputPath = 'dist') {
  const outputDirectory = resolve(outputPath);
  let files;
  try {
    files = await listFiles(outputDirectory);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Pages build check failed:')) throw error;
    fail(`could not read build output at ${outputDirectory}`);
  }

  const relativeFiles = files.map(path => relative(outputDirectory, path).split(sep).join('/'));
  const fileSet = new Set(relativeFiles);
  for (const requiredFile of ['index.html', 'service-worker.js', 'THIRD_PARTY_NOTICES.txt']) {
    if (!fileSet.has(requiredFile)) fail(`dist is missing ${requiredFile}`);
  }

  const wasmFilePaths = EXPECTED_WASM_PATHS.map(path => resolve(PROJECT_DIRECTORY, path));
  const expectedWasmHashes = new Set(await Promise.all(wasmFilePaths.map(async path => sha256(await readBytes(path)))));
  const wasmFiles = relativeFiles.filter(path => path.endsWith('.wasm'));
  if (wasmFiles.length !== expectedWasmHashes.size) {
    fail(`expected ${expectedWasmHashes.size} WASM files, found ${wasmFiles.length}`);
  }

  const actualWasmHashes = new Set(await Promise.all(wasmFiles.map(async path =>
    sha256(await readBytes(join(outputDirectory, ...path.split('/')))))));
  for (const expectedHash of expectedWasmHashes) {
    if (!actualWasmHashes.has(expectedHash)) fail(`WASM hash ${expectedHash} does not match the installed package`);
  }

  const indexPath = join(outputDirectory, 'index.html');
  const htmlBytes = await readBytes(indexPath);
  const html = htmlBytes.toString('utf8');
  const workerSource = (await readBytes(join(outputDirectory, 'service-worker.js'))).toString('utf8');
  if (/__OFFLINE_(?:BUILD_ID|BASE_PATH|ASSETS)__/.test(workerSource)) fail('service-worker.js still contains build placeholders');

  const { buildId, basePath, assets } = parseWorkerManifest(workerSource);
  if (basePath !== EXPECTED_BASE_PATH) fail(`worker base path must be ${EXPECTED_BASE_PATH}`);

  const buildMeta = [...html.matchAll(/<meta\s+name="offline-build"\s+content="([a-f0-9]{64})"\s*\/?\s*>/gi)];
  if (buildMeta.length !== 1) fail('index.html must contain exactly one offline-build meta tag');
  if (buildMeta[0][1] !== buildId) fail('index.html build id does not match service-worker.js');

  const manifestByUrl = new Map();
  const manifestPaths = new Set();
  for (const asset of assets) {
    if (!asset || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 0 ||
        typeof asset.hashed !== 'boolean') {
      fail('service-worker.js contains a malformed manifest entry');
    }
    if (!asset.url.startsWith(EXPECTED_BASE_PATH) || asset.url.startsWith('//')) {
      fail(`manifest URL is outside the Pages base path: ${asset.url}`);
    }
    const url = new URL(asset.url, 'https://pages.invalid');
    if (url.origin !== 'https://pages.invalid' || url.search || url.hash ||
        !url.pathname.startsWith(EXPECTED_BASE_PATH)) {
      fail(`manifest URL must be a same-origin path under ${EXPECTED_BASE_PATH}: ${asset.url}`);
    }

    const relativePath = decodeURIComponent(url.pathname.slice(EXPECTED_BASE_PATH.length));
    if (!relativePath || !isAllowedPrecachePath(relativePath)) fail(`manifest contains an unsupported asset path: ${asset.url}`);
    if (manifestByUrl.has(asset.url)) fail(`manifest contains a duplicate URL: ${asset.url}`);
    if (asset.hashed !== contentHashedPath(relativePath)) fail(`manifest hash flag does not match path: ${asset.url}`);
    if (/\.(?:gguf|safetensors|pt|pth|bin|onnx|tgz)$/i.test(relativePath)) {
      fail(`manifest must not include model weights or package archives: ${asset.url}`);
    }

    const outputFile = safeOutputFile(outputDirectory, url.pathname.slice(EXPECTED_BASE_PATH.length));
    const contents = await readBytes(outputFile);
    if (contents.byteLength !== asset.size) fail(`manifest size does not match build output: ${asset.url}`);
    const digest = sha256(contents);
    if (digest !== asset.sha256) fail(`manifest hash does not match build output: ${asset.url}`);

    manifestByUrl.set(asset.url, asset);
    manifestPaths.add(relativePath);
  }

  for (const requiredFile of ['index.html', 'THIRD_PARTY_NOTICES.txt']) {
    if (!manifestPaths.has(requiredFile)) fail(`service-worker.js manifest is missing ${requiredFile}`);
  }
  for (const path of relativeFiles.filter(path => path !== 'service-worker.js' && /\.(?:js|css|wasm)$/i.test(path))) {
    if (!manifestPaths.has(path)) fail(`service-worker.js manifest is missing emitted application asset ${path}`);
  }

  const assetReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  const localReferences = assetReferences.filter(reference => reference.startsWith('/') && !reference.startsWith('//'));
  const localJsReferences = [];
  const localCssReferences = [];
  for (const reference of localReferences) {
    if (!reference.startsWith(EXPECTED_BASE_PATH)) {
      fail(`local reference does not use the configured Pages base path: ${reference}`);
    }
    if (!manifestByUrl.has(reference)) fail(`index.html references an asset absent from the manifest: ${reference}`);
    if (reference.endsWith('.js')) localJsReferences.push(reference);
    if (reference.endsWith('.css')) localCssReferences.push(reference);
  }
  if (!localJsReferences.length) fail(`index.html does not reference JavaScript below ${EXPECTED_BASE_PATH}`);
  if (!localCssReferences.length) fail(`index.html does not reference CSS below ${EXPECTED_BASE_PATH}`);
  if (!assetReferences.includes(`${EXPECTED_BASE_PATH}THIRD_PARTY_NOTICES.txt`)) {
    fail('index.html does not link to the included third-party notices using the Pages base path');
  }

  const modelFile = relativeFiles.find(path => /\.(?:gguf|safetensors|pt|pth|bin|onnx|tgz)$/i.test(path));
  if (modelFile) fail(`build output must not contain model weights or package archives: ${modelFile}`);

  return { fileCount: files.length, manifestEntryCount: assets.length, outputDirectory };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const outputPath = process.argv[2] ?? 'dist';
  try {
    const result = await verifyBuildOutput(outputPath);
    console.log(`Verified ${result.fileCount} files and ${result.manifestEntryCount} offline assets in ${result.outputDirectory}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { verifyBuildOutput };
