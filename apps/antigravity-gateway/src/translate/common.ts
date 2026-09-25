// Common translation helpers ported from CLIProxyAPI:
// - defaultSafetySettings: internal/translator/gemini/common/safety.go
// - sanitizeFunctionName:   internal/util/util.go SanitizeFunctionName
// - sanitizeSchema:         internal/util/gemini_schema.go CleanJSONSchemaForGemini
//
// The schema cleaner is a value-based recursive port of the gjson/sjson pipeline.
// Walking parsed values makes "isPropertyDefinition" (a key under properties/
// patternProperties/$defs/definitions is an author-chosen name, not a schema
// keyword) structural: map keys under those containers are never examined as
// keywords, only their schema values are recursed into.

import type { GeminiSafetySetting } from "./types";

// ---------------------------------------------------------------------------
// Safety settings
// ---------------------------------------------------------------------------

export function defaultSafetySettings(): GeminiSafetySetting[] {
  return [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
  ];
}

// ---------------------------------------------------------------------------
// Function name sanitization
// ---------------------------------------------------------------------------

const INVALID_FUNCTION_NAME_CHAR = /[^a-zA-Z0-9_.:-]/g;
const MAX_FUNCTION_NAME_LENGTH = 64;

// Mirrors Go SanitizeFunctionName: invalid chars -> "_", must start with a
// letter or underscore (prepend "_" otherwise, truncating first to stay within
// 64 chars), empty input -> "_", hard truncate at 64 chars.
export function sanitizeFunctionName(name: string): string {
  if (name === "") return "";

  let sanitized = name.replace(INVALID_FUNCTION_NAME_CHAR, "_");

  if (sanitized.length > 0) {
    const first = sanitized.charCodeAt(0);
    const isLower = first >= 97 && first <= 122;
    const isUpper = first >= 65 && first <= 90;
    const isUnderscore = first === 95;
    if (!isLower && !isUpper && !isUnderscore) {
      if (sanitized.length >= MAX_FUNCTION_NAME_LENGTH) {
        sanitized = sanitized.slice(0, MAX_FUNCTION_NAME_LENGTH - 1);
      }
      sanitized = "_" + sanitized;
    }
  } else {
    sanitized = "_";
  }

  if (sanitized.length > MAX_FUNCTION_NAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_FUNCTION_NAME_LENGTH);
  }
  return sanitized;
}

// Claude tool_use ids must match ^[a-zA-Z0-9_-]+$. Empty results get a
// generated fallback (Go uses time+counter; a counter is enough for a single
// translation session).
const INVALID_TOOL_ID_CHAR = /[^a-zA-Z0-9_-]/g;
let toolIdFallbackCounter = 0;

export function sanitizeClaudeToolId(id: string): string {
  const sanitized = id.replace(INVALID_TOOL_ID_CHAR, "_");
  if (sanitized === "") {
    toolIdFallbackCounter += 1;
    return `toolu_${Date.now()}_${toolIdFallbackCounter}`;
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// JSON schema cleaning (CleanJSONSchemaForGemini)
// ---------------------------------------------------------------------------

const PLACEHOLDER_REASON_DESCRIPTION = "Brief explanation of why you are calling this tool";

// Constraint keywords moved into description hints (Gemini options: the
// antigravity-only minimum/maximum/multipleOf are NOT included).
const CONSTRAINT_KEYWORDS = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "format",
  "default",
  "examples"
] as const;

// Keywords deleted outright (Gemini options: "not" is antigravity-only and is
// NOT deleted here).
const UNSUPPORTED_KEYWORDS = [
  ...CONSTRAINT_KEYWORDS,
  "$schema",
  "$defs",
  "definitions",
  "const",
  "$ref",
  "$id",
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "if",
  "then",
  "else",
  "$comment",
  "enumDescriptions",
  "enumTitles",
  "prefill",
  "deprecated"
] as const;

// Gemini metadata removal (removeGeminiMetadata).
const METADATA_KEYWORDS = ["nullable", "title"] as const;

type SchemaObject = { [key: string]: unknown };

function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeHint(existing: string, hint: string): string {
  if (existing === "") return hint;
  if (existing === hint || existing.startsWith(hint + " (") || existing.includes(`(${hint})`)) {
    return existing;
  }
  return `${existing} (${hint})`;
}

function appendDescriptionHint(node: SchemaObject, hint: string): void {
  const existing = typeof node.description === "string" ? node.description : "";
  node.description = mergeHint(existing, hint);
}

// Phase 1 (convertRefsToHints, preserveSiblings=false): any node carrying a
// $ref is replaced wholesale by {type:"object", description:"See: <name>"}
// (existing description is merged). Local refs are NOT inlined on the Gemini
// path, so every $ref lands here.
function transformRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(transformRefs);
  if (!isPlainObject(node)) return node;

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const lastSlash = ref.lastIndexOf("/");
    const defName = lastSlash >= 0 && lastSlash + 1 < ref.length ? ref.slice(lastSlash + 1) : ref;
    const hint = `See: ${defName}`;
    const replacement: SchemaObject = { type: "object" };
    const existing = typeof node.description === "string" ? node.description : "";
    replacement.description = existing !== "" ? `${existing} (${hint})` : hint;
    return replacement;
  }

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = transformRefs(value);
  }
  return out;
}

// Phase: mergeConditionals — then/else branches with a properties map contribute
// their properties into the parent's properties (first wins). The then/else
// keywords themselves are dropped later as unsupported keywords.
function mergeConditionals(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(mergeConditionals);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = mergeConditionals(value);
  }

  for (const branchKey of ["then", "else"] as const) {
    const branch = out[branchKey];
    if (!isPlainObject(branch) || !isPlainObject(branch.properties)) continue;
    if (!isPlainObject(out.properties)) out.properties = {};
    const parentProps = out.properties as SchemaObject;
    for (const [propName, propSchema] of Object.entries(branch.properties as SchemaObject)) {
      if (!(propName in parentProps)) {
        parentProps[propName] = propSchema;
      }
    }
  }
  return out;
}

// Phase: mergeAllOf — required arrays union; other object fields merged when
// absent; nested if/then/else/allOf inside items are dropped.
function mergeAllOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(mergeAllOf);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = mergeAllOf(value);
  }

  const allOf = out.allOf;
  if (!Array.isArray(allOf)) return out;

  for (const itemRaw of allOf) {
    if (!isPlainObject(itemRaw)) continue;
    for (const [field, value] of Object.entries(itemRaw)) {
      if (field === "required" && Array.isArray(value)) {
        const current = Array.isArray(out.required) ? (out.required as unknown[]) : [];
        for (const req of value) {
          if (!current.includes(req)) current.push(req);
        }
        out.required = current;
      } else if (field === "if" || field === "then" || field === "else" || field === "allOf") {
        // Conditional applicability cannot be represented upstream.
      } else if (!(field in out)) {
        out[field] = mergeAllOf(value);
      }
    }
  }
  delete out.allOf;
  return out;
}

function selectBestBranch(items: unknown[]): { bestIndex: number; types: string[] } {
  let bestScore = -1;
  let bestIndex = 0;
  const types: string[] = [];
  items.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const t = typeof item.type === "string" ? item.type : "";
    let score: number;
    let resolvedType: string;
    if (t === "object" || isPlainObject(item.properties)) {
      score = 3;
      resolvedType = t || "object";
    } else if (t === "array" || isPlainObject(item.items)) {
      score = 2;
      resolvedType = t || "array";
    } else if (t !== "" && t !== "null") {
      score = 1;
      resolvedType = t;
    } else {
      score = 0;
      resolvedType = t || "null";
    }
    if (resolvedType !== "") types.push(resolvedType);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return { bestIndex, types };
}

// Phase: flattenAnyOfOneOf — pick the strongest branch; a null sibling makes
// the selection nullable; descriptions and type-list hints are merged.
function flattenUnions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(flattenUnions);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = flattenUnions(value);
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = out[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const items = branches.filter(isPlainObject);
    if (items.length === 0) {
      delete out[keyword];
      continue;
    }

    const parentDesc = typeof out.description === "string" ? out.description : "";
    const { bestIndex, types } = selectBestBranch(items);
    let selected = items[bestIndex] as SchemaObject;
    const hasNull = items.some((item) => item.type === "null");
    if (hasNull && selected.type !== "null") {
      selected = { ...selected, nullable: true };
    }
    if (parentDesc !== "") {
      const childDesc = typeof selected.description === "string" ? selected.description : "";
      selected = {
        ...selected,
        description: childDesc === "" ? parentDesc : childDesc === parentDesc ? childDesc : `${parentDesc} (${childDesc})`
      };
    }
    if (types.length > 1) {
      appendDescriptionHint(selected, `Accepts: ${types.join(" | ")}`);
    }
    delete out[keyword];
    // Replace this node's schema keywords with the selected branch, keeping
    // non-schema siblings (none expected at a schema node).
    for (const [key, value] of Object.entries(selected)) {
      out[key] = value;
    }
  }
  return out;
}

// Phase: flattenTypeArrays — type arrays collapse to the first non-null type;
// a null member makes properties nullable (removed from required, "(nullable)"
// hint); multiple non-null types get an "Accepts:" hint.
function flattenTypeArrays(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(flattenTypeArrays);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = flattenTypeArrays(value);
  }

  if (!Array.isArray(out.type)) return out;

  const types = out.type as unknown[];
  const nonNullTypes: string[] = [];
  let hasNull = false;
  for (const item of types) {
    if (typeof item !== "string" || item === "") continue;
    if (item === "null") hasNull = true;
    else nonNullTypes.push(item);
  }

  out.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";

  if (nonNullTypes.length > 1) {
    appendDescriptionHint(out, `Accepts: ${nonNullTypes.join(" | ")}`);
  }

  if (hasNull && isPlainObject(out.properties)) {
    const props = out.properties as SchemaObject;
    for (const propName of Object.keys(props)) {
      appendDescriptionHint(props[propName] as SchemaObject, "(nullable)");
    }
    if (Array.isArray(out.required)) {
      const nullableNames = new Set(Object.keys(props));
      out.required = (out.required as unknown[]).filter((req) => !nullableNames.has(req as string));
      if ((out.required as unknown[]).length === 0) delete out.required;
    }
  }
  return out;
}

// Phases: convertConstToEnum + convertEnumValuesToStrings(forceStringType) +
// addEnumHints, in a single bottom-up walk matching the Go phase order.
function convertEnums(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertEnums);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = convertEnums(value);
  }

  // const -> enum (only when no enum exists yet).
  if ("const" in out && !Array.isArray(out.enum)) {
    out.enum = [out.const];
  }

  // enum values -> strings, force parent type to string.
  if (Array.isArray(out.enum)) {
    const stringValues = (out.enum as unknown[]).map((item) => String(item));
    out.enum = stringValues;
    out.type = "string";
    // addEnumHints: 2..10 members get an "Allowed:" hint.
    if (stringValues.length > 1 && stringValues.length <= 10) {
      appendDescriptionHint(out, `Allowed: ${stringValues.join(", ")}`);
    }
  }
  return out;
}

// Phases: addAdditionalPropertiesHints + moveConstraintsToDescription.
function moveConstraintsToHints(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(moveConstraintsToHints);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = moveConstraintsToHints(value);
  }

  if (out.additionalProperties === false) {
    appendDescriptionHint(out, "No extra properties allowed");
  }
  for (const keyword of CONSTRAINT_KEYWORDS) {
    const value = out[keyword];
    if (value === undefined) continue;
    if (isPlainObject(value) || Array.isArray(value)) continue;
    appendDescriptionHint(out, `${keyword}: ${String(value)}`);
  }
  return out;
}

// Phase: removeUnsupportedKeywords + x-* extensions + removeGeminiMetadata
// (nullable/title) + removePlaceholderFields. Property names under
// properties/patternProperties are author-chosen names, so their keys are
// never treated as keywords — the recursion below only inspects schema nodes,
// not the keys of name-map containers.
function removeUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(removeUnsupported);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) continue;
    if ((METADATA_KEYWORDS as readonly string[]).includes(key)) continue;
    if (key.startsWith("x-")) continue;
    out[key] = removeUnsupported(value);
  }

  removePlaceholderFields(out);
  return out;
}

// Placeholder-only properties ("_" always; "reason" only when it is the sole
// property and carries the VALIDATED placeholder description) are removed,
// along with their required entries.
function removePlaceholderFields(node: SchemaObject): void {
  const props = node.properties;
  if (!isPlainObject(props)) return;

  const isPlaceholder = (name: string, schema: unknown): boolean => {
    if (name === "_") return true;
    if (name !== "reason" || !isPlainObject(schema)) return false;
    const propNames = Object.keys(props as SchemaObject);
    return propNames.length === 1 && schema.description === PLACEHOLDER_REASON_DESCRIPTION;
  };

  const removed = new Set<string>();
  for (const [name, schema] of Object.entries(props as SchemaObject)) {
    if (isPlaceholder(name, schema)) {
      delete (props as SchemaObject)[name];
      removed.add(name);
    }
  }
  if (removed.size === 0) return;

  if (Array.isArray(node.required)) {
    const filtered = (node.required as unknown[]).filter((req) => !removed.has(req as string));
    if (filtered.length === 0) delete node.required;
    else node.required = filtered;
  }
}

// Phase: cleanupRequiredFields — required entries must name an existing
// property; stale entries are dropped.
function cleanupRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanupRequired);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = cleanupRequired(value);
  }

  if (Array.isArray(out.required) && isPlainObject(out.properties)) {
    const propNames = new Set(Object.keys(out.properties as SchemaObject));
    const valid = (out.required as unknown[]).filter((req) => propNames.has(req as string));
    if (valid.length === 0) delete out.required;
    else out.required = valid;
  }
  return out;
}

// Phase: convertPrefixItems — JSON Schema 2020-12 tuple validation. Gemini has
// no tuple concept and requires a single `items` schema on every array, so an
// array carrying only `prefixItems` is rejected with "items: missing field".
// The strongest positional branch becomes `items` (reusing the anyOf/oneOf
// scoring), with a hint recording the original tuple shape. An array that
// already has `items` keeps it and merely drops `prefixItems`.
function convertPrefixItems(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertPrefixItems);
  if (!isPlainObject(node)) return node;

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = convertPrefixItems(value);
  }

  const prefixItems = out.prefixItems;
  if (!Array.isArray(prefixItems)) return out;
  delete out.prefixItems;

  // An empty positional list carries no shape information at all.
  if (prefixItems.length === 0) {
    if (!("items" in out)) out.items = { type: "string" };
    return out;
  }

  const positionHint = `Tuple of ${prefixItems.length} positional item(s)`;
  if ("items" in out) {
    appendDescriptionHint(out, positionHint);
    return out;
  }

  // `{}` (any-type) members carry no type, so they score 0 and only win when
  // nothing better exists; fall back to string as elsewhere in this module.
  const objectMembers = prefixItems.filter(isPlainObject);
  if (objectMembers.length === 0) {
    out.items = { type: "string" };
    appendDescriptionHint(out, positionHint);
    return out;
  }

  const { bestIndex, types } = selectBestBranch(objectMembers);
  const selected = { ...(objectMembers[bestIndex] as SchemaObject) };
  if (typeof selected.type !== "string" || selected.type === "") {
    selected.type = "string";
  }
  out.items = selected;

  const shapeHint = types.length > 0 ? `${positionHint}: ${types.join(", ")}` : positionHint;
  appendDescriptionHint(out, shapeHint);
  return out;
}

// CleanJSONSchemaForGemini port. Input is a parsed JSON schema value; output
// is a cleaned value ready for parametersJsonSchema.
export function sanitizeSchema(schema: unknown): unknown {
  let value = schema;
  value = transformRefs(value);
  value = mergeConditionals(value);
  value = mergeAllOf(value);
  value = flattenUnions(value);
  value = flattenTypeArrays(value);
  value = convertEnums(value);
  value = convertPrefixItems(value);
  value = moveConstraintsToHints(value);
  value = removeUnsupported(value);
  value = cleanupRequired(value);
  return value;
}
