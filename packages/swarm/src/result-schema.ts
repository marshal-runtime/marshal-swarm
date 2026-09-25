const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
type SchemaType = (typeof SCHEMA_TYPES)[number];
const COUNT_KEYWORDS: readonly string[] = ["minItems", "maxItems", "minLength", "maxLength"];
const BOUND_KEYWORDS: readonly string[] = ["minimum", "maximum"];
const TEXT_KEYWORDS: readonly string[] = ["description", "title"];
const SUPPORTED_KEYWORDS: readonly string[] = [
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  ...COUNT_KEYWORDS,
  ...BOUND_KEYWORDS,
  ...TEXT_KEYWORDS,
];
const PROBLEM_LIMIT = 12;

/** Lists why a value is not a supported result schema; empty when it is. */
export function resultSchemaProblems(schema: unknown, path = "resultSchema"): string[] {
  if (!isRecord(schema)) return [`${path} must be a JSON Schema object.`];
  const problems = Object.entries(schema).flatMap(([keyword, value]) =>
    keywordProblems(keyword, value, `${path}.${keyword}`),
  );
  return problems.slice(0, PROBLEM_LIMIT);
}

/** Lists how a value violates a supported result schema; empty when it conforms. */
export function resultValueProblems(value: unknown, schema: unknown, path = "result"): string[] {
  const problems: string[] = [];
  collectValueProblems(value, schema, path, problems);
  return problems.slice(0, PROBLEM_LIMIT);
}

function keywordProblems(keyword: string, value: unknown, at: string): string[] {
  if (!SUPPORTED_KEYWORDS.includes(keyword))
    return [`${at} is not supported; use only ${SUPPORTED_KEYWORDS.join(", ")}.`];
  switch (keyword) {
    case "type": {
      const types = Array.isArray(value) ? value : [value];
      return types.length && types.every((type) => SCHEMA_TYPES.includes(type as SchemaType))
        ? []
        : [`${at} must be one of ${SCHEMA_TYPES.join(", ")} or a non-empty array of them.`];
    }
    case "enum":
      return Array.isArray(value) && value.length ? [] : [`${at} must be a non-empty array.`];
    case "const":
      return [];
    case "properties":
      return isRecord(value)
        ? Object.entries(value).flatMap(([name, child]) => resultSchemaProblems(child, `${at}.${name}`))
        : [`${at} must be an object of schemas.`];
    case "required":
      return Array.isArray(value) && value.every((name) => typeof name === "string")
        ? []
        : [`${at} must be an array of property names.`];
    case "additionalProperties":
      return typeof value === "boolean" ? [] : resultSchemaProblems(value, at);
    case "items":
      return resultSchemaProblems(value, at);
  }
  if (COUNT_KEYWORDS.includes(keyword))
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? []
      : [`${at} must be a non-negative integer.`];
  if (BOUND_KEYWORDS.includes(keyword))
    return typeof value === "number" && Number.isFinite(value) ? [] : [`${at} must be a finite number.`];
  return typeof value === "string" ? [] : [`${at} must be a string.`];
}

function collectValueProblems(value: unknown, schema: unknown, path: string, problems: string[]): void {
  if (problems.length >= PROBLEM_LIMIT || !isRecord(schema)) return;
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as readonly SchemaType[];
    if (!types.some((type) => matchesType(value, type))) {
      problems.push(`${path} must be ${types.join(" or ")}; got ${typeName(value)}.`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value)))
    problems.push(`${path} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}.`);
  if (hasOwn(schema, "const") && !sameJson(schema.const, value))
    problems.push(`${path} must equal ${JSON.stringify(schema.const)}.`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength)
      problems.push(`${path} must have at least ${schema.minLength} characters.`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      problems.push(`${path} must have at most ${schema.maxLength} characters.`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      problems.push(`${path} must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      problems.push(`${path} must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      problems.push(`${path} must have at least ${schema.minItems} items.`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      problems.push(`${path} must have at most ${schema.maxItems} items.`);
    if (schema.items !== undefined)
      value.forEach((item, index) => collectValueProblems(item, schema.items, `${path}[${index}]`, problems));
  }
  if (isRecord(value)) collectObjectProblems(value, schema, path, problems);
}

function collectObjectProblems(
  value: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  problems: string[],
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  (Array.isArray(schema.required) ? schema.required : [])
    .filter((name): name is string => typeof name === "string" && !hasOwn(value, name))
    .forEach((name) => problems.push(`${path}.${name} is required.`));
  Object.entries(value).forEach(([name, item]) => {
    if (hasOwn(properties, name)) collectValueProblems(item, properties[name], `${path}.${name}`, problems);
    else if (schema.additionalProperties === false) problems.push(`${path}.${name} is not allowed.`);
    else collectValueProblems(item, schema.additionalProperties, `${path}.${name}`, problems);
  });
}

function matchesType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
