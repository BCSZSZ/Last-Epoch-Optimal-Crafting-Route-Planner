import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Catalog, MODEL_ID } from '../src/core/catalog';
import type { Model } from '../src/core/catalog';

/** Historical artifacts keep their original model ID; never relabel them as current-release measurements. */
export function recordCatalog(modelId: string, allowHistorical: boolean): Catalog {
  if (modelId === MODEL_ID) return new Catalog();
  if (!allowHistorical) throw new Error('Historical model requires explicit --historical replay');
  const root = new URL('../', import.meta.url);
  const manifest: { models: Record<string, { file: string; sha256: string }> } = JSON.parse(readFileSync(new URL('research/runtime-model-archive/manifest.json', root), 'utf8'));
  const entry = manifest.models[modelId];
  if (!entry || !entry.file.startsWith('research/runtime-model-archive/') || entry.file.includes('..')) throw new Error('Unregistered archived model');
  const content = readFileSync(new URL(entry.file, root));
  if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error('Archived model hash mismatch');
  const model: Model = JSON.parse(content.toString('utf8'));
  if (model.modelId !== modelId) throw new Error('Archived model identity mismatch');
  return new Catalog(model);
}
