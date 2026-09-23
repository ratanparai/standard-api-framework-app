// Shared Ajv instance for validating the assembled envelope against the live
// Api-Specs schemas (2019-09 dialect). Uses our own fetchDoc cache as Ajv's
// remote-ref loader so envelope validation and $ref resolution never
// double-fetch the same file.
import Ajv2019 from "ajv/dist/2019";
import addFormats from "ajv-formats";
import { fetchDoc } from "./loader";

let ajv: Ajv2019 | null = null;

export function getAjv(): Ajv2019 {
  if (ajv) return ajv;
  ajv = new Ajv2019({
    strict: false,
    // Upstream patterns use escapes that are invalid under the "u" flag (e.g.
    // Generics RegFINMANoType's `CHE\-FINMA…`), so compile them without it.
    unicodeRegExp: false,
    loadSchema: async (uri: string) => (await fetchDoc(uri)).json,
  });
  addFormats(ajv);
  return ajv;
}

/** Compile (with lazy remote $ref resolution) and validate `data` against the schema at `schemaUrl`. */
export async function validateAgainstSchema(schemaUrl: string, data: any): Promise<{ valid: boolean; errors: string[] }> {
  const instance = getAjv();
  const cacheKey = schemaUrl;
  let validateFn = instance.getSchema(cacheKey);
  if (!validateFn) {
    const schema = (await fetchDoc(schemaUrl)).json;
    // give the root schema an explicit $id so Ajv can cache/retrieve the compiled validator
    validateFn = await instance.compileAsync({ ...schema, $id: cacheKey });
  }
  const valid = !!validateFn(data);
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  return { valid, errors };
}
