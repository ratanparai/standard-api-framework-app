// Live JSON Schema → FieldSchema converter (the JSON counterpart of xsdParser.ts),
// used for the Generic Exchange payload so FormTree can render it unchanged.
//
// Value conventions match the XSD path (see format.ts): an object whose `oneOf`
// is made only of `{ required: [key] }` branches (exactly one of those keys —
// e.g. SenderReceiverType's broker|insurer|otherExchangePartner, CustomerType's
// company|person) gets those keys folded into a reserved "_choice" property
// holding `{ "@selected": key, [key]: {...} }`. fromFormValues() unwraps it back
// to plain JSON and prunes empty optional values so blank fields don't fail
// format/minItems checks.
import type { FieldSchema } from "../formSchema";
import { isObj } from "../format";
import { fetchDoc, resolveRef } from "./loader";

type ObjectField = Extract<FieldSchema, { kind: "object" }>;
type ChoiceField = Extract<FieldSchema, { kind: "choice" }>;

const MAX_DEPTH = 16;

/** Follow `$ref` chains, tracking the URL each node was resolved from (relative refs resolve against it). */
async function deref(node: any, baseUrl: string): Promise<{ node: any; baseUrl: string }> {
  let guard = 0;
  while (node && typeof node.$ref === "string" && guard++ < MAX_DEPTH) {
    const r = await resolveRef(baseUrl, node.$ref);
    node = r.node;
    baseUrl = r.url;
  }
  return { node, baseUrl };
}

/** Keys of a `oneOf: [{required:[a]}, {required:[b]}, ...]` exclusive-property pattern, else null. */
function exclusiveKeys(node: any): string[] | null {
  if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) return null;
  const keys: string[] = [];
  for (const b of node.oneOf) {
    if (!isObj(b) || Object.keys(b).some((k) => k !== "required") || !Array.isArray(b.required) || b.required.length !== 1) return null;
    keys.push(b.required[0]);
  }
  return keys;
}

function mergeFields(a: FieldSchema | null, b: FieldSchema | null): FieldSchema | null {
  if (!a) return b;
  if (!b) return a;
  if (a.kind === "object" && b.kind === "object") {
    return { kind: "object", properties: { ...a.properties, ...b.properties }, required: Array.from(new Set([...a.required, ...b.required])) };
  }
  if (a.kind === "enum" && b.kind === "enum") {
    const both = a.values.filter((v) => b.values.includes(v));
    return { kind: "enum", values: both.length ? both : b.values };
  }
  if (b.kind === "enum") return b;
  return a;
}

async function convert(raw: any, rawBase: string, depth: number): Promise<FieldSchema | null> {
  if (depth > MAX_DEPTH) return { kind: "unsupported", note: "Nested too deeply to render as a form — edit as JSON." };
  const { node, baseUrl } = await deref(raw, rawBase);
  if (!isObj(node)) return null;

  let own: FieldSchema | null = null;
  if (Array.isArray(node.enum)) own = { kind: "enum", values: node.enum.map(String) };
  else if (node.const !== undefined) own = { kind: "enum", values: [String(node.const)] };
  else {
    const type = Array.isArray(node.type) ? node.type.find((t: string) => t !== "null") : node.type;
    if (type === "object" || (!type && isObj(node.properties))) {
      const properties: Record<string, FieldSchema> = {};
      for (const [k, v] of Object.entries<any>(node.properties ?? {})) {
        const f = await convert(v, baseUrl, depth + 1);
        if (f) properties[k] = f;
      }
      const obj: ObjectField = { kind: "object", properties, required: Array.isArray(node.required) ? [...node.required] : [] };
      const excl = exclusiveKeys(node);
      if (excl && excl.every((k) => k in properties)) foldChoice(obj, excl);
      own = obj;
    } else if (type === "array" || (!type && node.items)) {
      const items = node.items ? await convert(node.items, baseUrl, depth + 1) : null;
      own = { kind: "array", items: items ?? { kind: "string" } };
    } else if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
      own = { kind: type, format: node.format };
    }
  }

  // allOf parts (e.g. a $ref plus a narrowing enum) merge into the node; parts
  // with only if/then conditionals convert to null and are left to Ajv.
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) own = mergeFields(own, await convert(part, baseUrl, depth + 1));
  }
  return own ?? { kind: "unsupported", note: "No form mapping for this part of the schema — edit as JSON." };
}

/** Replace exclusive properties with a single "_choice" property (placed where the first one was). */
function foldChoice(obj: ObjectField, keys: string[]) {
  let n = 1;
  while (`_choice${n === 1 ? "" : n}` in obj.properties) n++;
  const choiceKey = `_choice${n === 1 ? "" : n}`;
  const choice: ChoiceField = { kind: "choice", options: keys.map((k) => ({ label: k, schema: obj.properties[k] })) };
  const next: Record<string, FieldSchema> = {};
  for (const [k, v] of Object.entries(obj.properties)) {
    if (k === keys[0]) next[choiceKey] = choice;
    else if (!keys.includes(k)) next[k] = v;
  }
  obj.properties = next;
  obj.required = obj.required.filter((k) => !keys.includes(k));
}

/** Fetch + convert a JSON Schema to a FieldSchema (root keys in `hide` are dropped from the form). */
export async function loadJsonSchema(rootUrl: string, opts: { hide?: string[] } = {}): Promise<FieldSchema> {
  const root = (await fetchDoc(rootUrl)).json;
  const schema = await convert(root, rootUrl, 0);
  if (!schema || schema.kind !== "object") throw new Error(`${rootUrl} is not an object schema`);
  for (const k of opts.hide ?? []) delete schema.properties[k];
  schema.required = schema.required.filter((k) => !(opts.hide ?? []).includes(k));
  return schema;
}

/** Fetch + convert the schema, and fetch a sample instance converted to form values. */
export async function loadJsonSchemaForm(rootUrl: string, sampleUrl: string, opts: { hide?: string[] } = {}): Promise<{ schema: FieldSchema; sample: any }> {
  const [schema, sampleDoc] = await Promise.all([loadJsonSchema(rootUrl, opts), fetchDoc(sampleUrl)]);
  const sample = { ...sampleDoc.json };
  for (const k of opts.hide ?? []) delete sample[k];
  return { schema, sample: toFormValues(sample, schema) };
}

/** Plain JSON → form values (wraps exclusive keys into their "_choice" property). Unknown keys are kept as-is. */
export function toFormValues(json: any, schema: FieldSchema | undefined): any {
  if (!schema || json === undefined || json === null) return json;
  if (schema.kind === "array") return Array.isArray(json) ? json.map((it) => toFormValues(it, schema.items)) : json;
  if (schema.kind !== "object" || !isObj(json)) return json;
  const out: any = {};
  const consumed = new Set<string>();
  for (const [k, prop] of Object.entries(schema.properties)) {
    if (prop.kind === "choice" && k.startsWith("_choice")) {
      const opt = prop.options.find((o) => json[o.label] !== undefined);
      prop.options.forEach((o) => consumed.add(o.label));
      out[k] = opt
        ? { "@selected": opt.label, [opt.label]: toFormValues(json[opt.label], opt.schema) }
        : { "@selected": prop.options[0]?.label };
    } else if (json[k] !== undefined) {
      out[k] = toFormValues(json[k], prop);
      consumed.add(k);
    }
  }
  for (const [k, v] of Object.entries(json)) if (!consumed.has(k)) out[k] = v;
  return out;
}

/** Form values → plain JSON: unwrap "_choice" to the selected branch, drop "@selected", prune empty values. */
export function fromFormValues(values: any, schema?: FieldSchema): any {
  if (values === undefined || values === null || values === "") return undefined;
  if (Array.isArray(values)) {
    const items = schema?.kind === "array" ? schema.items : undefined;
    const arr = values.map((it) => fromFormValues(it, items)).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (!isObj(values)) return values;
  const props = schema?.kind === "object" ? schema.properties : {};
  const out: any = {};
  for (const [k, v] of Object.entries<any>(values)) {
    if (k === "@selected") continue;
    const prop = props[k];
    if (k.startsWith("_choice") && isObj(v)) {
      const options = prop?.kind === "choice" ? prop.options : [];
      const selected: string | undefined = v["@selected"] ?? options[0]?.label;
      if (!selected) continue;
      const branch = fromFormValues(v[selected], options.find((o) => o.label === selected)?.schema);
      if (branch !== undefined) out[selected] = branch;
      continue;
    }
    const val = fromFormValues(v, prop);
    if (val !== undefined) out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}
