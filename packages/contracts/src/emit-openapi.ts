import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './openapi.js';
import { ROUTES } from './routes.js';
import { toYaml } from './yaml.js';

/**
 * 从契约注册表发射 OpenAPI 3.1：
 * - packages/contracts/openapi.json：构建产物（gitignore），供人工评审与快照比对；
 * - docs/api/openapi.yaml：说明书真源（入库），CI 用 `pnpm openapi` + git diff 做漂移门禁。
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const jsonOut = join(here, '..', 'openapi.json');
const yamlOut = join(repoRoot, 'docs', 'api', 'openapi.yaml');

const doc = buildOpenApiDocument(ROUTES);
writeFileSync(jsonOut, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
writeFileSync(yamlOut, toYaml(doc), 'utf8');

const paths = Object.keys(doc.paths).length;
const operations = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
const schemas = Object.keys(doc.components.schemas).length;

console.log(`openapi.json written: ${jsonOut}`);
console.log(`openapi.yaml written: ${yamlOut}`);
console.log(`paths=${paths} operations=${operations} schemas=${schemas}`);
