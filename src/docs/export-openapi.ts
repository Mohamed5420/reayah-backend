/**
 * Writes the OpenAPI spec to docs/openapi.json for the mobile/web teams: `npm run openapi`.
 * Needs the same env vars as the app (.env), but no database or Redis.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getGlobalControllers } from '../api/controllers';
import { buildOpenApiDocument } from './openapi';

getGlobalControllers(); // constructing controllers registers every route
const outFile = resolve(__dirname, '../../docs/openapi.json');
writeFileSync(outFile, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`OpenAPI spec written to ${outFile}`);
process.exit(0);
