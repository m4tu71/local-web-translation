export interface ModelDefinition {
  readonly name: string;
  readonly repository: string;
  readonly revision: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const PLAMO_MODEL: ModelDefinition = Object.freeze({
  name: 'PLaMo 3 Translate 0.8B · Q4_K_M',
  repository: 'pfnet/plamo-3-translate-0.8b-GGUF',
  revision: 'dbeb0856cb0b004b484f190bb71dd65876297013',
  fileName: 'plamo-3-translate-0.8b-Q4_K_M.gguf',
  bytes: 573123200,
  sha256: '923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd',
});

export function modelDownloadUrl(model: ModelDefinition): string {
  const repository = model.repository.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repository}/resolve/${encodeURIComponent(model.revision)}/${encodeURIComponent(model.fileName)}`;
}
