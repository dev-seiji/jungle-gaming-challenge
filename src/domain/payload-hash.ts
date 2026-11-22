import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves de objeto em ordem alfabética, em qualquer profundidade.
 * Assim {"a":1,"b":2} e {"b":2,"a":1} viram o mesmo texto e o mesmo hash.
 * Campos undefined somem (igual ao JSON.stringify), então "ausente" e "undefined" são iguais.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** SHA-256 (hex) do JSON canônico. Quem chama escolhe os campos de negócio; header e metadados de transporte não entram. */
export function payloadHash(businessFields: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(businessFields)).digest('hex');
}
