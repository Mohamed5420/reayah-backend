/**
 * OpenAPI 3.1 → Postman collection v2.1, for the mobile team (`npm run openapi` writes both).
 * Folders follow the OpenAPI tags; `{{baseUrl}}` and `{{accessToken}}` are collection variables, so
 * one login request's token works everywhere. Request bodies are examples built from the schemas.
 */

type Json = Record<string, unknown>;
type Schema = Json & {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  example?: unknown;
  examples?: unknown[];
  default?: unknown;
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  const?: unknown;
  minimum?: number;
};
type Operation = {
  summary?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema; description?: string }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
};
type OpenApi = {
  info: { title: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

const exampleFor = (schema: Schema | undefined, doc: OpenApi, depth = 0): unknown => {
  if (!schema || depth > 8) return null;
  if (schema.$ref)
    return exampleFor(doc.components?.schemas?.[schema.$ref.split('/').pop()!], doc, depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return exampleFor(variants.find((v) => v.type !== 'null') ?? variants[0], doc, depth + 1);
  if (schema.allOf)
    return Object.assign({}, ...schema.allOf.map((s) => exampleFor(s, doc, depth + 1) as Json));
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([k, v]) => [k, exampleFor(v, doc, depth + 1)]),
      );
    case 'array':
      return [exampleFor(schema.items, doc, depth + 1)];
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'string':
      if (schema.format === 'date-time') return '2026-10-05T14:00:00Z';
      if (schema.format === 'date') return '2026-10-05';
      if (schema.format === 'uuid') return '7b1e3a52-0c7d-4d3e-9a51-2f6c1f0e8a11';
      return 'string';
    default:
      return null;
  }
};

export const buildPostmanCollection = (doc: OpenApi, apiPrefix: string) => {
  const folders = new Map<string, Json[]>();
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(operations)) {
      const relative = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
      const segments = relative
        .split('/')
        .filter(Boolean)
        .map((s) => s.replace(/^\{(.+)\}$/, ':$1'));
      const params = op.parameters ?? [];
      const body = op.requestBody?.content?.['application/json']?.schema;
      const multipart = op.requestBody?.content?.['multipart/form-data']?.schema;
      const isPublic = !op.security?.length;

      const request: Json = {
        method: method.toUpperCase(),
        description: op.summary,
        ...(isPublic ? { auth: { type: 'noauth' } } : {}),
        header: [
          { key: 'Accept-Language', value: 'ar' },
          ...params
            .filter((p) => p.in === 'header')
            .map((p) => ({ key: p.name, value: p.name === 'Idempotency-Key' ? '{{$guid}}' : '' })),
        ],
        url: {
          raw: `{{baseUrl}}/${segments.join('/')}`,
          host: ['{{baseUrl}}'],
          path: segments,
          query: params
            .filter((p) => p.in === 'query')
            .map((p) => ({
              key: p.name,
              value: String(exampleFor(p.schema, doc) ?? ''),
              disabled: !p.required,
              description: p.description,
            })),
          variable: params
            .filter((p) => p.in === 'path')
            .map((p) => ({ key: p.name, value: String(exampleFor(p.schema, doc) ?? '') })),
        },
        ...(body
          ? {
              body: {
                mode: 'raw',
                raw: JSON.stringify(exampleFor(body, doc), null, 2),
                options: { raw: { language: 'json' } },
              },
            }
          : {}),
        ...(multipart
          ? {
              body: {
                mode: 'formdata',
                formdata: Object.entries((multipart as Schema).properties ?? {}).map(([key, s]) =>
                  s.format === 'binary'
                    ? { key, type: 'file', src: [] }
                    : { key, type: 'text', value: String(exampleFor(s, doc) ?? '') },
                ),
              },
            }
          : {}),
      };
      const tag = op.tags?.[0] ?? 'Other';
      folders.set(tag, [
        ...(folders.get(tag) ?? []),
        { name: op.summary ?? `${method.toUpperCase()} ${relative}`, request },
      ]);
    }
  }

  return {
    info: {
      name: doc.info.title,
      description: `${doc.info.description ?? ''}\n\nSet \`baseUrl\`, then call "Verify OTP" (or "Refresh") and paste \`access_token\` into the \`accessToken\` variable.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
    variable: [
      { key: 'baseUrl', value: `http://localhost:3000${apiPrefix}` },
      { key: 'accessToken', value: '' },
    ],
    item: [...folders.entries()].map(([name, item]) => ({ name, item })),
  };
};
