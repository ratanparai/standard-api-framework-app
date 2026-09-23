import { Folder, Plus, Trash2 } from "lucide-react";
import { ENUMS, WIDE_KEYS } from "../data/standards";
import { humanize, isObj } from "../lib/format";
import type { FieldSchema } from "../lib/formSchema";

// Recursive nested form editor (PRD F6 — read/edit payload as a structured form).
// Without a `schema`, it reflects whatever shape `values` happens to have (the
// original behavior, kept as the offline/no-live-schema fallback). With a
// `schema` (from the XSD converter, src/lib/schema/xsdParser.ts), it renders
// fields/groups/enums/required-markers driven by the real legacy XSD instead.
function Leaf({ pathKey, value, path, readOnly, onChange, opts, required }: {
  pathKey: string; value: any; path: string; readOnly: boolean; onChange: (p: string, v: any) => void;
  opts?: string[]; required?: boolean;
}) {
  const options = opts ?? ENUMS[pathKey];
  const wide = WIDE_KEYS.includes(pathKey);

  let field;
  if (readOnly) {
    field = <div className={"leaf-ro" + (value === "" || value == null ? " empty" : "")}>{String(value ?? "—")}</div>;
  } else if (options) {
    const list = value !== "" && value != null && !options.includes(value) ? [value, ...options] : options;
    field = (
      <div className="selectw">
        <select value={String(value ?? "")} onChange={(e) => onChange(path, e.target.value)}>
          {list.map((o) => <option key={o}>{o}</option>)}
        </select>
      </div>
    );
  } else if (wide) {
    field = <textarea className="ctl" rows={2} value={String(value ?? "")} onChange={(e) => onChange(path, e.target.value)} />;
  } else {
    const isNum = typeof value === "number";
    const isDate = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    field = (
      <input
        className="ctl"
        type={isNum ? "number" : isDate ? "date" : "text"}
        value={String(value ?? "")}
        onChange={(e) => onChange(path, isNum ? Number(e.target.value) : e.target.value)}
      />
    );
  }

  return (
    <div className={"leaf" + (wide ? " wide" : "")}>
      <span className="leaf-key">{humanize(pathKey)}{required ? <span className="req-star">*</span> : null}</span>
      {field}
    </div>
  );
}

function Unsupported({ pathKey, note, value, path, readOnly, onChange }: {
  pathKey: string; note: string; value: any; path: string; readOnly: boolean; onChange: (p: string, v: any) => void;
}) {
  return (
    <div className="subgrp">
      <div className="grp-head"><Folder className="grp-icon" size={13} /><span className="grp-key">{humanize(pathKey)}</span></div>
      <div className="unsupported-note">{note}</div>
      <textarea
        className="code-edit" spellCheck={false} rows={4} readOnly={readOnly}
        value={String(value ?? "")} onChange={(e) => onChange(path, e.target.value)}
      />
    </div>
  );
}

function ChoiceNode({ pathKey, schema, value, path, readOnly, onChange }: {
  pathKey: string; schema: Extract<FieldSchema, { kind: "choice" }>; value: any; path: string;
  readOnly: boolean; onChange: (p: string, v: any) => void;
}) {
  const selected: string = value?.["@selected"] ?? schema.options[0]?.label ?? "";
  const active = schema.options.find((o) => o.label === selected);
  // Reserved "_choice" keys have no name of their own — label by the alternatives instead.
  const title = pathKey.startsWith("_choice") ? schema.options.map((o) => humanize(o.label)).join(" / ") : humanize(pathKey);
  return (
    <div className="subgrp">
      <div className="grp-head">
        <Folder className="grp-icon" size={13} />
        <span className="grp-key">{title}</span>
        <div className="selectw" style={{ marginLeft: "auto" }}>
          <select value={selected} disabled={readOnly} onChange={(e) => onChange(`${path}.@selected`, e.target.value)}>
            {schema.options.map((o) => <option key={o.label} value={o.label}>{humanize(o.label)}</option>)}
          </select>
        </div>
      </div>
      {active && (
        <FieldNode
          pathKey={active.label} schema={active.schema} value={value?.[active.label] ?? {}}
          path={`${path}.${active.label}`} readOnly={readOnly} onChange={onChange}
        />
      )}
    </div>
  );
}

function ArrayNode({ pathKey, schema, value, path, readOnly, onChange }: {
  pathKey: string; schema: Extract<FieldSchema, { kind: "array" }>; value: any[]; path: string;
  readOnly: boolean; onChange: (p: string, v: any) => void;
}) {
  const items: any[] = Array.isArray(value) ? value : [];
  const setItems = (next: any[]) => onChange(path, next);
  return (
    <div className="subgrp">
      <div className="grp-head">
        <Folder className="grp-icon" size={13} />
        <span className="grp-key">{humanize(pathKey)}</span>
        <span className="grp-count">{items.length}</span>
        {!readOnly && (
          <button type="button" className="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setItems([...items, defaultForSchema(schema.items)])}>
            <Plus size={12} /> Add
          </button>
        )}
      </div>
      {items.map((item, i) => (
        <div className="subgrp" key={i}>
          <div className="grp-head">
            <span className="grp-key">#{i + 1}</span>
            {!readOnly && (
              <button type="button" className="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                <Trash2 size={12} />
              </button>
            )}
          </div>
          <FieldNode pathKey={`${pathKey}[${i}]`} schema={schema.items} value={item} path={`${path}.${i}`} readOnly={readOnly} onChange={onChange} />
        </div>
      ))}
    </div>
  );
}

function defaultForSchema(schema: FieldSchema): any {
  if (schema.kind === "object") {
    const o: any = {};
    for (const k of Object.keys(schema.properties)) o[k] = defaultForSchema(schema.properties[k]);
    return o;
  }
  if (schema.kind === "array") return [];
  if (schema.kind === "choice") return { "@selected": schema.options[0]?.label };
  if (schema.kind === "boolean") return false;
  if (schema.kind === "number" || schema.kind === "integer") return 0;
  return "";
}

/** Render one schema-typed field (used both at the top level and recursively). */
function FieldNode({ pathKey, schema, value, path, readOnly, onChange }: {
  pathKey: string; schema: FieldSchema; value: any; path: string; readOnly: boolean; onChange: (p: string, v: any) => void;
}) {
  switch (schema.kind) {
    case "object":
      return (
        <div className="subgrp">
          {schema.attributes && Object.keys(schema.attributes).length > 0 && (
            <div className="grp-body">
              {Object.entries(schema.attributes).map(([k, s]) => (
                <FieldNode key={`@${k}`} pathKey={`@${k}`} schema={s} value={value?.["@attributes"]?.[k]}
                  path={`${path}.@attributes.${k}`} readOnly={readOnly} onChange={onChange} />
              ))}
            </div>
          )}
          <ObjectNode schema={schema} value={value ?? {}} base={path} readOnly={readOnly} onChange={onChange} />
        </div>
      );
    case "array":
      return <ArrayNode pathKey={pathKey} schema={schema} value={value} path={path} readOnly={readOnly} onChange={onChange} />;
    case "choice":
      return <ChoiceNode pathKey={pathKey} schema={schema} value={value} path={path} readOnly={readOnly} onChange={onChange} />;
    case "unsupported":
      return <Unsupported pathKey={pathKey} note={schema.note} value={value} path={path} readOnly={readOnly} onChange={onChange} />;
    case "enum":
      return <Leaf pathKey={pathKey} value={value} path={path} readOnly={readOnly} onChange={onChange} opts={schema.values} />;
    default:
      return <Leaf pathKey={pathKey} value={value} path={path} readOnly={readOnly} onChange={onChange} />;
  }
}

/** Object-kind schema: render its own properties as leaves/groups, schema-driven. */
function ObjectNode({ schema, value, base, readOnly, onChange }: {
  schema: Extract<FieldSchema, { kind: "object" }>; value: any; base: string; readOnly: boolean; onChange: (p: string, v: any) => void;
}) {
  const keys = Object.keys(schema.properties);
  return (
    <div className="grp-body">
      {keys.map((k) => {
        const fieldSchema = schema.properties[k];
        const path = base ? `${base}.${k}` : k;
        if (fieldSchema.kind === "choice") {
          // ChoiceNode renders its own group header (with the branch selector).
          return <FieldNode key={k} pathKey={k} schema={fieldSchema} value={value?.[k]} path={path} readOnly={readOnly} onChange={onChange} />;
        }
        if (fieldSchema.kind === "object" || fieldSchema.kind === "array" || fieldSchema.kind === "unsupported") {
          return (
            <div className="subgrp" key={k}>
              <div className="grp-head"><Folder className="grp-icon" size={13} /><span className="grp-key">{humanize(k)}</span></div>
              <FieldNode pathKey={k} schema={fieldSchema} value={value?.[k]} path={path} readOnly={readOnly} onChange={onChange} />
            </div>
          );
        }
        const opts = fieldSchema.kind === "enum" ? fieldSchema.values : undefined;
        return (
          <Leaf key={k} pathKey={k} value={value?.[k]} path={path} readOnly={readOnly} onChange={onChange}
            opts={opts} required={schema.required.includes(k)} />
        );
      })}
    </div>
  );
}

// No-schema reflection path (original behavior — offline / no live schema fallback).
function Node({ obj, base, readOnly, onChange }: {
  obj: any; base: string; readOnly: boolean; onChange: (p: string, v: any) => void;
}) {
  const keys = Object.keys(obj);
  const leaves = keys.filter((k) => !isObj(obj[k]));
  const groups = keys.filter((k) => isObj(obj[k]));

  return (
    <div className="grp-body">
      {leaves.map((k) => (
        <Leaf key={k} pathKey={k} value={obj[k]} path={base ? `${base}.${k}` : k} readOnly={readOnly} onChange={onChange} />
      ))}
      {groups.map((k) => {
        const child = obj[k];
        return (
          <div className="subgrp" key={k}>
            <div className="grp-head">
              <Folder className="grp-icon" size={13} />
              <span className="grp-key">{k}</span>
              <span className="grp-count">{Object.keys(child).length}</span>
            </div>
            <Node obj={child} base={base ? `${base}.${k}` : k} readOnly={readOnly} onChange={onChange} />
          </div>
        );
      })}
    </div>
  );
}

export default function FormTree({ values, readOnly = false, onChange, schema }: {
  values: any; readOnly?: boolean; onChange?: (path: string, value: any) => void; schema?: FieldSchema;
}) {
  const handleChange = onChange ?? (() => {});
  return (
    <div className="form-tree">
      {schema && schema.kind === "object"
        ? <ObjectNode schema={schema} value={values} base="" readOnly={readOnly} onChange={handleChange} />
        : <Node obj={values} base="" readOnly={readOnly} onChange={handleChange} />}
    </div>
  );
}
