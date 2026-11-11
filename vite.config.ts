import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const OFFLINE_WORKER_PATH = fileURLToPath(new URL('./src/offline/service-worker.js', import.meta.url));
const OFFLINE_WORKER_TEMPLATE = readFileSync(OFFLINE_WORKER_PATH, 'utf8');
const DEFAULT_BASE_PATH = '/local-web-translation/';

type OfflineAsset = {
  url: string;
  sha256: string;
  size: number;
  hashed: boolean;
};

type OfflineBundleFile =
  | { type: 'asset'; source: string | Uint8Array }
  | { type: 'chunk'; code: string };

type OfflineOutputBundle = Record<string, OfflineBundleFile>;

function getOutputBytes(output: OfflineBundleFile): Buffer {
  if (output.type === 'chunk') return Buffer.from(output.code, 'utf8');
  if (typeof output.source === 'string') return Buffer.from(output.source, 'utf8');
  return Buffer.from(output.source);
}

function sha256(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function isPrecachePath(path: string): boolean {
  if (path === 'index.html' || path === 'THIRD_PARTY_NOTICES.txt') return true;
  return /\.(?:js|css|wasm|svg|png|jpe?g|webp|ico|woff2?)$/i.test(path);
}

function hasContentHash(path: string): boolean {
  return /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path);
}

function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith('/') || !basePath.endsWith('/') || basePath.startsWith('//')) {
    throw new Error(`Offline worker requires an absolute base path ending in slash: ${basePath}`);
  }
  return basePath;
}

function selectPrecacheAssets(bundle: OfflineOutputBundle, basePath: string): OfflineAsset[] {
  const assets: OfflineAsset[] = [];
  for (const [fileName, output] of Object.entries(bundle)) {
    if (!isPrecachePath(fileName)) continue;
    const contents = getOutputBytes(output);
    assets.push({
      url: `${basePath}${encodeURI(fileName)}`,
      sha256: sha256(contents),
      size: contents.byteLength,
      hashed: hasContentHash(fileName),
    });
  }

  assets.sort((left, right) => left.url.localeCompare(right.url));
  if (!assets.some(asset => asset.url === `${basePath}index.html`)) {
    throw new Error('Offline worker build is missing index.html');
  }
  if (!assets.some(asset => asset.url === `${basePath}THIRD_PARTY_NOTICES.txt`)) {
    throw new Error('Offline worker build is missing THIRD_PARTY_NOTICES.txt');
  }
  return assets;
}

function addBuildIdMeta(html: string, buildId: string): string {
  const metaTag = `<meta name="offline-build" content="${buildId}">`;
  const existingMeta = /<meta\b(?=[^>]*\bname\s*=\s*["']offline-build["'])[^>]*>/i;
  if (existingMeta.test(html)) return html.replace(existingMeta, metaTag);

  const headTag = /<head\b[^>]*>/i;
  if (!headTag.test(html)) throw new Error('Offline worker build could not find the index.html head element');
  return html.replace(headTag, match => `${match}\n    ${metaTag}`);
}

function computeBuildId(assets: OfflineAsset[], workerTemplate: string): string {
  const assetFingerprint = assets.map(({ url, sha256: digest, size }) => `${url}\0${digest}\0${size}`).join('\n');
  const templateHash = sha256(workerTemplate);
  return sha256(`${assetFingerprint}\nworker-template\0${templateHash}`);
}

function listOutputFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listOutputFiles(path);
    if (entry.isFile()) return [path];
    throw new Error(`Offline worker build output must not contain symbolic links: ${path}`);
  });
}

function createOfflineWorkerPlugin(
  basePath = DEFAULT_BASE_PATH,
  workerTemplate = OFFLINE_WORKER_TEMPLATE,
): Plugin {
  const normalizedBasePath = normalizeBasePath(basePath);
  let projectRoot = process.cwd();

  return {
    name: 'local-web-translation-offline-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      projectRoot = config.root;
    },
    writeBundle(outputOptions) {
      if (!outputOptions.dir) throw new Error('Offline worker build requires a directory output');
      const outputDirectory = resolve(projectRoot, outputOptions.dir);
      const bundle: OfflineOutputBundle = {};
      for (const path of listOutputFiles(outputDirectory)) {
        const fileName = relative(outputDirectory, path).split(sep).join('/');
        if (fileName === 'service-worker.js' || !isPrecachePath(fileName)) continue;
        bundle[fileName] = { type: 'asset', source: readFileSync(path) };
      }

      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') throw new Error('Offline worker build is missing the written index.html file');

      const initialAssets = selectPrecacheAssets(bundle, normalizedBasePath);
      const buildId = computeBuildId(initialAssets, workerTemplate);
      const indexFilePath = join(outputDirectory, 'index.html');
      index.source = addBuildIdMeta(String(index.source), buildId);
      writeFileSync(indexFilePath, index.source);

      bundle['index.html'] = { type: 'asset', source: index.source };
      const finalAssets = selectPrecacheAssets(bundle, normalizedBasePath);
      const workerSource = workerTemplate
        .replaceAll('__OFFLINE_BUILD_ID__', JSON.stringify(buildId))
        .replaceAll('__OFFLINE_BASE_PATH__', JSON.stringify(normalizedBasePath))
        .replaceAll('__OFFLINE_ASSETS__', JSON.stringify(finalAssets));

      writeFileSync(join(outputDirectory, 'service-worker.js'), workerSource);
    },
  };
}

export { addBuildIdMeta, computeBuildId, createOfflineWorkerPlugin, selectPrecacheAssets };

export default defineConfig({
  base: DEFAULT_BASE_PATH,
  plugins: [createOfflineWorkerPlugin()],
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
