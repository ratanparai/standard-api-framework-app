// Internal form-schema representation consumed by FormTree.tsx, produced by
// the XSD converter (src/lib/schema/xsdParser.ts) for the 5 legacy processes
// with a real XSD (invoice, commission, contract, mandate, claimsExperience)
// and by the JSON Schema converter (src/lib/schema/jsonSchemaForm.ts) for the
// Generic Exchange payload. offer.nlpi / ids / inquiry / error use a plain
// free-text "data" textarea instead (see SendEvent.tsx).
export type FieldSchema =
  | { kind: "object"; properties: Record<string, FieldSchema>; required: string[]; attributes?: Record<string, FieldSchema> }
  | { kind: "array"; items: FieldSchema }
  | { kind: "choice"; options: { label: string; schema: FieldSchema }[] }
  | { kind: "enum"; values: string[] }
  | { kind: "string" | "number" | "integer" | "boolean"; format?: string }
  | { kind: "unsupported"; note: string };

export const isObjectSchema = (s: FieldSchema): s is Extract<FieldSchema, { kind: "object" }> => s.kind === "object";
