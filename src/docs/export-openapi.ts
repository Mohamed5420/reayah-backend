/**
 * Writes the API docs for the mobile/web teams: `npm run openapi` →
 * docs/openapi.json (OpenAPI 3.1) and docs/postman_collection.json (Postman v2.1).
 * Needs the same env vars as the app (.env), but no database or Redis.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getGlobalControllers } from '../api/controllers';
import { env } from '../config/env.config';
import { buildOpenApiDocument } from './openapi';
import { buildPostmanCollection } from './postman';

getGlobalControllers(); // constructing controllers registers every route
const doc = buildOpenApiDocument();
const docsDir = resolve(__dirname, '../../docs');
writeFileSync(resolve(docsDir, 'openapi.json'), `${JSON.stringify(doc, null, 2)}\n`);
writeFileSync(
  resolve(docsDir, 'postman_collection.json'),
  `${JSON.stringify(buildPostmanCollection(doc as never, env.apiPrefix), null, 2)}\n`,
);
console.log(`API docs written to ${docsDir} (openapi.json, postman_collection.json)`);
process.exit(0);
