import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './openapi.js';
import { ROUTES } from './routes.js';

/** 发射 OpenAPI 3.1 到 packages/contracts/openapi.json（构建产物，供人工评审与快照比对）。 */
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'openapi.json');
const doc = buildOpenApiDocument(ROUTES);
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`openapi.json written: ${out}`);
console.log(`paths=${Object.keys(doc.paths).length} operations=${Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0)} schemas=${Object.keys(doc.components.schemas).length}`);
