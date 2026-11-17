import { parseHexColor } from "./color";

export type TokenRequestType =
  | "create_paint_style"
  | "create_text_style"
  | "create_variable_collection"
  | "create_variable"
  | "set_variable_values"
  | "bind_variable"
  | "delete_style"
  | "delete_variable"
  | "delete_variable_collection";

type Params = Record<string, unknown>;
type PaintField = "fill" | "stroke";
type BindableField = PaintField | VariableBindableNodeField;

const RESOLVED_TYPES: readonly VariableResolvedDataType[] = ["COLOR", "FLOAT", "STRING", "BOOLEAN"];
const TEXT_CASES: readonly TextCase[] = [
  "ORIGINAL",
  "UPPER",
  "LOWER",
  "TITLE",
  "SMALL_CAPS",
  "SMALL_CAPS_FORCED",
];
const TEXT_DECORATIONS: readonly TextDecoration[] = ["NONE", "UNDERLINE", "STRIKETHROUGH"];
const NODE_FIELDS: readonly VariableBindableNodeField[] = [
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "opacity",
  "visible",
  "characters",
  "cornerRadius",
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "strokeWeight",
];

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.some((entry) => entry === value);

const isBindableField = (value: unknown): value is BindableField =>
  value === "fill" || value === "stroke" || isOneOf(NODE_FIELDS, value);

const requireString = (params: Params, key: string, tool: string): string => {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required for ${tool}`);
  }
  return value;
};

const optionalNumber = (params: Params, key: string, tool: string): number | undefined => {
  const value = params[key];
  if (value !== undefined && typeof value !== "number") {
    throw new Error(`${tool}: ${key} must be a number`);
  }
  return value;
};

/** Accepts #RGB, #RRGGBB, or #RRGGBBAA (alpha as the last byte). */
const parseHexRgba = (hex: string): RGBA => {
  const trimmed = hex.trim();
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) {
    return { ...parseHexColor(trimmed.slice(0, 7)), a: parseInt(trimmed.slice(7), 16) / 255 };
  }
  return { ...parseHexColor(trimmed), a: 1 };
};

const getVariable = async (id: string, tool: string): Promise<Variable> => {
  const variable = await figma.variables.getVariableByIdAsync(id);
  if (!variable) {
    throw new Error(`${tool}: variable not found: ${id}`);
  }
  return variable;
};

const getCollection = async (id: string, tool: string): Promise<VariableCollection> => {
  const collection = await figma.variables.getVariableCollectionByIdAsync(id);
  if (!collection) {
    throw new Error(`${tool}: variable collection not found: ${id}`);
  }
  return collection;
};

const describeCollection = (collection: VariableCollection) => ({
  collectionId: collection.id,
  name: collection.name,
  modes: collection.modes,
  defaultModeId: collection.defaultModeId,
});

const modeIdFor = (collection: VariableCollection, key: string, tool: string): string => {
  const mode = collection.modes.find((entry) => entry.modeId === key || entry.name === key);
  if (!mode) {
    throw new Error(
      `${tool}: no mode "${key}" in collection "${collection.name}". Modes: ${collection.modes.map((entry) => entry.name).join(", ")}`
    );
  }
  return mode.modeId;
};

const toVariableValue = async (
  raw: unknown,
  type: VariableResolvedDataType,
  tool: string
): Promise<VariableValue> => {
  if (typeof raw === "object" && raw !== null && "alias" in raw && typeof raw.alias === "string") {
    return figma.variables.createVariableAlias(await getVariable(raw.alias, tool));
  }
  if (type === "COLOR" && typeof raw === "string") return parseHexRgba(raw);
  if (type === "FLOAT" && typeof raw === "number") return raw;
  if (type === "STRING" && typeof raw === "string") return raw;
  if (type === "BOOLEAN" && typeof raw === "boolean") return raw;
  throw new Error(
    `${tool}: value ${JSON.stringify(raw)} does not fit a ${type} variable (COLOR takes a hex string, or pass { alias: variableId })`
  );
};

/** Sets each `values` entry (keyed by mode name or modeId) on the variable. */
const applyValues = async (variable: Variable, values: unknown, tool: string) => {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error(`${tool}: values must be an object keyed by mode name or modeId`);
  }
  const collection = await getCollection(variable.variableCollectionId, tool);
  for (const [modeKey, raw] of Object.entries(values)) {
    const modeId = modeIdFor(collection, modeKey, tool);
    variable.setValueForMode(modeId, await toVariableValue(raw, variable.resolvedType, tool));
  }
};

const describeVariable = (variable: Variable) => ({
  variableId: variable.id,
  name: variable.name,
  resolvedType: variable.resolvedType,
  collectionId: variable.variableCollectionId,
  valuesByMode: variable.valuesByMode,
});

const createPaintStyle = (params: Params) => {
  const tool = "create_paint_style";
  const style = figma.createPaintStyle();
  style.name = requireString(params, "name", tool);
  const opacity = optionalNumber(params, "opacity", tool);
  style.paints = [
    {
      type: "SOLID",
      color: parseHexColor(requireString(params, "hex", tool)),
      opacity: opacity ?? 1,
    },
  ];
  if (typeof params.description === "string") style.description = params.description;
  return { styleId: style.id, name: style.name, paints: style.paints };
};

const createTextStyle = async (params: Params) => {
  const tool = "create_text_style";
  const fontName: FontName = {
    family: requireString(params, "fontFamily", tool),
    style: typeof params.fontStyle === "string" ? params.fontStyle : "Regular",
  };
  // Load before creating so a missing font leaves no empty style behind.
  await figma.loadFontAsync(fontName);
  const fontSize = optionalNumber(params, "fontSize", tool);
  const letterSpacing = optionalNumber(params, "letterSpacing", tool);
  const { lineHeight, textCase, textDecoration } = params;
  if (lineHeight !== undefined && lineHeight !== "AUTO" && typeof lineHeight !== "number") {
    throw new Error(`${tool}: lineHeight must be a number of pixels or "AUTO"`);
  }
  if (textCase !== undefined && !isOneOf(TEXT_CASES, textCase)) {
    throw new Error(`${tool}: textCase must be one of ${TEXT_CASES.join(", ")}`);
  }
  if (textDecoration !== undefined && !isOneOf(TEXT_DECORATIONS, textDecoration)) {
    throw new Error(`${tool}: textDecoration must be one of ${TEXT_DECORATIONS.join(", ")}`);
  }

  const style = figma.createTextStyle();
  style.name = requireString(params, "name", tool);
  style.fontName = fontName;
  if (fontSize !== undefined) style.fontSize = fontSize;
  if (lineHeight !== undefined) {
    style.lineHeight =
      lineHeight === "AUTO" ? { unit: "AUTO" } : { unit: "PIXELS", value: lineHeight };
  }
  if (letterSpacing !== undefined) style.letterSpacing = { unit: "PIXELS", value: letterSpacing };
  if (textCase !== undefined) style.textCase = textCase;
  if (textDecoration !== undefined) style.textDecoration = textDecoration;
  if (typeof params.description === "string") style.description = params.description;
  return {
    styleId: style.id,
    name: style.name,
    fontName: style.fontName,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textCase: style.textCase,
    textDecoration: style.textDecoration,
  };
};

const createVariableCollection = (params: Params) => {
  const tool = "create_variable_collection";
  const { modes } = params;
  if (
    modes !== undefined &&
    (!Array.isArray(modes) || !modes.every((m) => typeof m === "string"))
  ) {
    throw new Error(`${tool}: modes must be a list of mode names`);
  }
  const collection = figma.variables.createVariableCollection(requireString(params, "name", tool));
  const [first, ...rest] = modes ?? [];
  try {
    if (first !== undefined) collection.renameMode(collection.defaultModeId, first);
    // addMode throws on plans that limit modes per collection.
    for (const mode of rest) collection.addMode(mode);
  } catch (err) {
    collection.remove();
    throw err;
  }
  return describeCollection(collection);
};

const createVariable = async (params: Params) => {
  const tool = "create_variable";
  const { resolvedType } = params;
  if (!isOneOf(RESOLVED_TYPES, resolvedType)) {
    throw new Error(`${tool}: resolvedType must be one of ${RESOLVED_TYPES.join(", ")}`);
  }
  const collection = await getCollection(requireString(params, "collectionId", tool), tool);
  const variable = figma.variables.createVariable(
    requireString(params, "name", tool),
    collection,
    resolvedType
  );
  try {
    if (typeof params.description === "string") variable.description = params.description;
    if (params.values !== undefined) await applyValues(variable, params.values, tool);
  } catch (err) {
    // Don't leave a half-configured variable behind when a value is rejected.
    variable.remove();
    throw err;
  }
  return describeVariable(variable);
};

const requireConfirm = (params: Params, tool: string): void => {
  if (params.confirm !== true) {
    throw new Error(`${tool} requires confirm: true`);
  }
};

const deleteStyle = async (params: Params) => {
  const tool = "delete_style";
  requireConfirm(params, tool);
  const styleId = requireString(params, "styleId", tool);
  const style = await figma.getStyleByIdAsync(styleId);
  if (!style) {
    throw new Error(`${tool}: style not found: ${styleId}`);
  }
  if (style.remote) {
    throw new Error(`${tool}: "${style.name}" comes from a library; delete it in its source file`);
  }
  const deleted = { styleId: style.id, name: style.name, type: style.type };
  style.remove();
  return { deleted };
};

const deleteVariable = async (params: Params) => {
  const tool = "delete_variable";
  requireConfirm(params, tool);
  const variable = await getVariable(requireString(params, "variableId", tool), tool);
  if (variable.remote) {
    throw new Error(
      `${tool}: "${variable.name}" comes from a library; delete it in its source file`
    );
  }
  const deleted = describeVariable(variable);
  variable.remove();
  return { deleted };
};

const deleteVariableCollection = async (params: Params) => {
  const tool = "delete_variable_collection";
  requireConfirm(params, tool);
  const collection = await getCollection(requireString(params, "collectionId", tool), tool);
  if (collection.remote) {
    throw new Error(
      `${tool}: "${collection.name}" comes from a library; delete it in its source file`
    );
  }
  const deleted = { ...describeCollection(collection), variableIds: collection.variableIds };
  collection.remove();
  return { deleted };
};

const setVariableValues = async (params: Params) => {
  const tool = "set_variable_values";
  const variable = await getVariable(requireString(params, "variableId", tool), tool);
  const previous = variable.valuesByMode;
  await applyValues(variable, params.values, tool);
  return { ...describeVariable(variable), previous };
};

/**
 * Binds the color of the first paint. A missing or non-solid first paint gets a
 * solid paint placed in front, since only solid paints can take a color variable.
 */
const rebindFirstPaint = (
  paints: ReadonlyArray<Paint> | PluginAPI["mixed"],
  variable: Variable | null,
  where: string
): Paint[] => {
  if (typeof paints === "symbol") {
    throw new Error(`bind_variable: ${where} has mixed paints; set a single paint first`);
  }
  const [first, ...rest] = paints;
  if (first?.type === "SOLID") {
    return [figma.variables.setBoundVariableForPaint(first, "color", variable), ...rest];
  }
  if (variable === null) return [...paints];
  const solid: SolidPaint = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
  return [figma.variables.setBoundVariableForPaint(solid, "color", variable), ...paints];
};

const bindPaint = (node: SceneNode, field: PaintField, variable: Variable | null): void => {
  if (field === "fill") {
    if (!("fills" in node)) throw new Error(`bind_variable: ${node.type} has no fills: ${node.id}`);
    node.fills = rebindFirstPaint(node.fills, variable, `${node.id} fills`);
    return;
  }
  if (!("strokes" in node))
    throw new Error(`bind_variable: ${node.type} has no strokes: ${node.id}`);
  node.strokes = rebindFirstPaint(node.strokes, variable, `${node.id} strokes`);
};

const bindVariable = async (nodes: SceneNode[], params: Params) => {
  const tool = "bind_variable";
  const { field, variableId } = params;
  if (!isBindableField(field)) {
    throw new Error(`${tool}: field must be fill, stroke or one of ${NODE_FIELDS.join(", ")}`);
  }
  if (variableId !== null && typeof variableId !== "string") {
    throw new Error(`${tool}: variableId must be a variable ID, or null to unbind`);
  }
  if (nodes.length === 0) {
    throw new Error(`nodeId or nodeIds is required for ${tool}`);
  }
  const variable = variableId === null ? null : await getVariable(variableId, tool);
  const results: unknown[] = [];
  for (const node of nodes) {
    try {
      const previous = node.boundVariables;
      if (field === "fill" || field === "stroke") {
        bindPaint(node, field, variable);
      } else {
        node.setBoundVariable(field, variable);
      }
      results.push({
        nodeId: node.id,
        nodeName: node.name,
        previous,
        applied: node.boundVariables,
      });
    } catch (err) {
      if (nodes.length === 1) throw err;
      results.push({ nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results };
};

export const runTokenTool = async (
  type: TokenRequestType,
  nodes: SceneNode[],
  params: Params
): Promise<unknown> => {
  switch (type) {
    case "create_paint_style":
      return createPaintStyle(params);
    case "create_text_style":
      return createTextStyle(params);
    case "create_variable_collection":
      return createVariableCollection(params);
    case "create_variable":
      return createVariable(params);
    case "set_variable_values":
      return setVariableValues(params);
    case "bind_variable":
      return bindVariable(nodes, params);
    case "delete_style":
      return deleteStyle(params);
    case "delete_variable":
      return deleteVariable(params);
    case "delete_variable_collection":
      return deleteVariableCollection(params);
  }
};
