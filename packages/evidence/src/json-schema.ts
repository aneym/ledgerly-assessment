/**
 * A small JSON Schema 2020-12 subset validator. It covers exactly the keywords
 * the two lane schemas use: type, const, enum, pattern, minLength, minimum,
 * format date-time, required, properties, additionalProperties, items,
 * minItems, uniqueItems, allOf, if/then/else. Anything else is ignored, so the
 * schema files stay the single source of truth and no rule is retyped here.
 */

export interface SchemaIssue {
  path: string;
  message: string;
}

export type JsonSchema = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasType(v: unknown, t: string): boolean {
  switch (t) {
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return false;
  }
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    isObject(val)
      ? Object.fromEntries(
          Object.keys(val)
            .sort()
            .map((k) => [k, val[k]]),
        )
      : val,
  );
}

export function validate(schema: JsonSchema, value: unknown, path = "$"): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const push = (message: string) => issues.push({ path, message });

  const type = schema.type;
  if (typeof type === "string" && !hasType(value, type)) {
    push(`expected ${type}`);
    return issues;
  }
  if ("const" in schema && value !== schema.const) push(`expected const ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    push(`expected one of ${schema.enum.map(String).join(", ")}`);

  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      push(`does not match ${schema.pattern}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      push(`shorter than ${schema.minLength}`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) push("not a date-time");
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum)
    push(`below minimum ${schema.minimum}`);

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      push(`fewer than ${schema.minItems} items`);
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map(stable));
      if (seen.size !== value.length) push("items are not unique");
    }
    if (isObject(schema.items)) {
      const items = schema.items as JsonSchema;
      value.forEach((item, i) => {
        issues.push(...validate(items, item, `${path}[${i}]`));
      });
    }
  }

  if (isObject(value)) {
    if (Array.isArray(schema.required))
      for (const key of schema.required as string[]) if (!(key in value)) push(`missing ${key}`);
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const [key, sub] of Object.entries(props))
      if (key in value && isObject(sub))
        issues.push(...validate(sub, value[key], `${path}.${key}`));
    const extra = Object.entries(value).filter(([key]) => !(key in props));
    if (schema.additionalProperties === false) {
      for (const [key] of extra) push(`unexpected ${key}`);
    } else if (isObject(schema.additionalProperties)) {
      const sub = schema.additionalProperties as JsonSchema;
      for (const [key, v] of extra) issues.push(...validate(sub, v, `${path}.${key}`));
    }
  }

  if (Array.isArray(schema.allOf))
    for (const sub of schema.allOf) if (isObject(sub)) issues.push(...validate(sub, value, path));

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(isObject);
    if (!branches.some((sub) => validate(sub, value, path).length === 0))
      push(`matches none of ${branches.length} alternatives`);
  }

  if (isObject(schema.if)) {
    const holds = validate(schema.if, value, path).length === 0;
    const branch = holds ? schema.then : schema.else;
    if (isObject(branch)) issues.push(...validate(branch, value, path));
  }

  return issues;
}
