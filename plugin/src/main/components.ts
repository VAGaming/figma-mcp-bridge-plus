export type ComponentRequestType =
  | "list_components"
  | "get_component_properties"
  | "create_component"
  | "create_component_set"
  | "create_instance"
  | "add_component_property"
  | "edit_component_property"
  | "delete_component_property"
  | "bind_component_property"
  | "set_instance_properties"
  | "detach_instance";

type Params = Record<string, unknown>;
type Parent = BaseNode & ChildrenMixin;
type PropertyOwner = ComponentNode | ComponentSetNode;
type PropertyValues = Record<string, string | boolean>;
type BindableField = "visible" | "characters" | "mainComponent";

const PROPERTY_TYPES: readonly ComponentPropertyType[] = [
  "BOOLEAN",
  "TEXT",
  "INSTANCE_SWAP",
  "VARIANT",
];
const BINDABLE_FIELDS: readonly BindableField[] = ["visible", "characters", "mainComponent"];

const isPropertyType = (value: unknown): value is ComponentPropertyType =>
  PROPERTY_TYPES.some((type) => type === value);

const isBindableField = (value: unknown): value is BindableField =>
  BINDABLE_FIELDS.some((field) => field === value);

const isPropertyValue = (value: unknown): value is string | boolean =>
  typeof value === "string" || typeof value === "boolean";

const summarize = (node: SceneNode) => ({ nodeId: node.id, nodeName: node.name });

const requireNode = (nodes: SceneNode[], tool: string): SceneNode => {
  if (nodes.length === 0) {
    throw new Error(`nodeId is required for ${tool}`);
  }
  return nodes[0];
};

const requireString = (params: Params, key: string, tool: string): string => {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required for ${tool}`);
  }
  return value;
};

/**
 * Applies `fn` to every node. A single-node call fails loudly; a batch reports
 * per-node errors so one bad node does not hide the others' results.
 */
const forEachNode = async <T>(
  nodes: SceneNode[],
  tool: string,
  fn: (node: SceneNode) => T | Promise<T>
) => {
  if (nodes.length === 0) {
    throw new Error(`nodeId or nodeIds is required for ${tool}`);
  }
  if (nodes.length === 1) {
    return { results: [await fn(nodes[0])] };
  }
  const results: Array<T | { nodeId: string; error: string }> = [];
  for (const node of nodes) {
    try {
      results.push(await fn(node));
    } catch (err) {
      results.push({ nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results };
};

/**
 * Component properties live on the component set for variants, so a variant
 * resolves to its set (Figma throws when reading definitions off a variant).
 */
const getPropertyOwner = (node: BaseNode, tool: string): PropertyOwner => {
  if (node.type === "COMPONENT_SET") return node;
  if (node.type === "COMPONENT") {
    const parent = node.parent;
    return parent?.type === "COMPONENT_SET" ? parent : node;
  }
  throw new Error(`${tool} requires a COMPONENT or COMPONENT_SET node, got ${node.type}`);
};

const requireInstance = (node: SceneNode, tool: string): InstanceNode => {
  if (node.type !== "INSTANCE") {
    throw new Error(`${tool} requires an INSTANCE node, got ${node.type}: ${node.id}`);
  }
  return node;
};

const requireProperty = (owner: PropertyOwner, propertyName: string, tool: string) => {
  const definitions = owner.componentPropertyDefinitions;
  if (!(propertyName in definitions)) {
    throw new Error(
      `${tool}: no property "${propertyName}" on ${owner.id}. Available: ${Object.keys(definitions).join(", ") || "(none)"}`
    );
  }
  return definitions[propertyName];
};

const toPropertyValues = (value: unknown, tool: string): PropertyValues => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`properties must be an object for ${tool}`);
  }
  const values: PropertyValues = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isPropertyValue(entry)) {
      throw new Error(`${tool}: property "${name}" must be a string or boolean`);
    }
    values[name] = entry;
  }
  return values;
};

const instanceValues = (instance: InstanceNode) =>
  Object.fromEntries(
    Object.entries(instance.componentProperties).map(([name, property]) => [name, property.value])
  );

const pageNameOf = (node: BaseNode): string | undefined => {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE") {
    current = current.parent;
  }
  return current?.name;
};

const listVariants = (set: ComponentSetNode) =>
  set.children.map((child) => ({ nodeId: child.id, nodeName: child.name }));

const listComponents = async (params: Params) => {
  const allPages = params.allPages === true;
  if (allPages) {
    // Under documentAccess "dynamic-page" other pages are unloaded until asked for.
    await figma.loadAllPagesAsync();
  }
  const root = allPages ? figma.root : figma.currentPage;
  const components = root
    .findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })
    // Variants are reported under their set rather than as top-level entries.
    .filter((node) => node.parent?.type !== "COMPONENT_SET")
    .map((node) => ({
      ...summarize(node),
      type: node.type,
      key: node.key,
      page: pageNameOf(node),
      ...(node.type === "COMPONENT_SET" ? { variants: listVariants(node) } : {}),
    }));
  return { count: components.length, components };
};

const getComponentProperties = async (node: SceneNode) => {
  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    const owner = main ? getPropertyOwner(main, "get_component_properties") : null;
    return {
      ...summarize(node),
      type: node.type,
      mainComponentId: main?.id,
      mainComponentName: main?.name,
      componentSetId: owner?.type === "COMPONENT_SET" ? owner.id : undefined,
      properties: node.componentProperties,
      definitions: owner?.componentPropertyDefinitions,
    };
  }
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    const owner = getPropertyOwner(node, "get_component_properties");
    return {
      ...summarize(owner),
      type: owner.type,
      definitions: owner.componentPropertyDefinitions,
      ...(owner.type === "COMPONENT_SET"
        ? { defaultVariantId: owner.defaultVariant?.id, variants: listVariants(owner) }
        : {}),
    };
  }
  // A layer inside a component: report which properties it is bound to.
  return {
    ...summarize(node),
    type: node.type,
    componentPropertyReferences: node.componentPropertyReferences,
  };
};

const createComponentSet = (nodes: SceneNode[], params: Params, parent?: Parent) => {
  const components = nodes.filter((node): node is ComponentNode => node.type === "COMPONENT");
  if (components.length === 0 || components.length !== nodes.length) {
    throw new Error(
      "create_component_set requires COMPONENT nodes only (convert layers with create_component first)"
    );
  }
  const target = parent ?? components[0].parent;
  if (!target) {
    throw new Error("create_component_set could not resolve a parent; pass parentId");
  }
  const set = figma.combineAsVariants(components, target);
  if (typeof params.name === "string") {
    set.name = params.name;
  }
  return {
    ...summarize(set),
    parentId: set.parent?.id,
    variants: listVariants(set),
    definitions: set.componentPropertyDefinitions,
  };
};

const createInstance = async (nodes: SceneNode[], params: Params, parent?: Parent) => {
  const source = requireNode(nodes, "create_instance");
  if (source.type !== "COMPONENT" && source.type !== "COMPONENT_SET") {
    throw new Error(
      `create_instance requires a COMPONENT or COMPONENT_SET node, got ${source.type}`
    );
  }
  const component = source.type === "COMPONENT_SET" ? source.defaultVariant : source;
  const instance = component.createInstance();
  parent?.appendChild(instance);
  if (typeof params.x === "number") instance.x = params.x;
  if (typeof params.y === "number") instance.y = params.y;
  if (typeof params.name === "string") instance.name = params.name;
  if (params.properties !== undefined) {
    instance.setProperties(toPropertyValues(params.properties, "create_instance"));
  }
  return {
    ...summarize(instance),
    parentId: instance.parent?.id,
    // Setting a VARIANT property swaps the main component, so read it back.
    mainComponentId: (await instance.getMainComponentAsync())?.id,
    properties: instanceValues(instance),
  };
};

const addComponentProperty = (node: SceneNode, params: Params) => {
  const tool = "add_component_property";
  const owner = getPropertyOwner(node, tool);
  const name = requireString(params, "name", tool);
  const { type, defaultValue } = params;
  if (!isPropertyType(type)) {
    throw new Error(`${tool}: type must be one of ${PROPERTY_TYPES.join(", ")}`);
  }
  if (!isPropertyValue(defaultValue)) {
    throw new Error(`${tool}: defaultValue must be a string or boolean`);
  }
  const propertyName = owner.addComponentProperty(name, type, defaultValue);
  return { ...summarize(owner), propertyName, definitions: owner.componentPropertyDefinitions };
};

const editComponentProperty = (node: SceneNode, params: Params) => {
  const tool = "edit_component_property";
  const owner = getPropertyOwner(node, tool);
  const propertyName = requireString(params, "propertyName", tool);
  const previous = requireProperty(owner, propertyName, tool);
  const { newName, defaultValue } = params;
  if (defaultValue !== undefined && !isPropertyValue(defaultValue)) {
    throw new Error(`${tool}: defaultValue must be a string or boolean`);
  }
  const renamed = owner.editComponentProperty(propertyName, {
    ...(typeof newName === "string" ? { name: newName } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  });
  return {
    ...summarize(owner),
    propertyName: renamed,
    previous,
    definitions: owner.componentPropertyDefinitions,
  };
};

const deleteComponentProperty = (node: SceneNode, params: Params) => {
  const tool = "delete_component_property";
  if (params.confirm !== true) {
    throw new Error(`${tool} requires confirm: true`);
  }
  const owner = getPropertyOwner(node, tool);
  const propertyName = requireString(params, "propertyName", tool);
  const deleted = requireProperty(owner, propertyName, tool);
  owner.deleteComponentProperty(propertyName);
  return {
    ...summarize(owner),
    propertyName,
    deleted,
    definitions: owner.componentPropertyDefinitions,
  };
};

const bindComponentProperty = (nodes: SceneNode[], params: Params) => {
  const tool = "bind_component_property";
  const { field, propertyName } = params;
  if (!isBindableField(field)) {
    throw new Error(`${tool}: field must be one of ${BINDABLE_FIELDS.join(", ")}`);
  }
  if (propertyName !== null && typeof propertyName !== "string") {
    throw new Error(`${tool}: propertyName must be a property name, or null to unbind`);
  }
  return forEachNode(nodes, tool, (node) => {
    const previous = node.componentPropertyReferences;
    const next = { ...(previous ?? {}) };
    if (propertyName === null) {
      delete next[field];
    } else {
      next[field] = propertyName;
    }
    node.componentPropertyReferences = next;
    return { ...summarize(node), previous, applied: node.componentPropertyReferences };
  });
};

const setInstanceProperties = (nodes: SceneNode[], params: Params) => {
  const tool = "set_instance_properties";
  const values = toPropertyValues(params.properties, tool);
  return forEachNode(nodes, tool, (node) => {
    const instance = requireInstance(node, tool);
    const previous = instanceValues(instance);
    instance.setProperties(values);
    return { ...summarize(instance), previous, applied: instanceValues(instance) };
  });
};

const detachInstances = (nodes: SceneNode[]) =>
  forEachNode(nodes, "detach_instance", (node) => {
    const instance = requireInstance(node, "detach_instance");
    const instanceId = instance.id;
    const frame = instance.detachInstance();
    return { instanceId, ...summarize(frame), type: frame.type };
  });

/**
 * Runs a component tool. `nodes` are the already-resolved request nodeIds and
 * `parent` the resolved `parentId` param, when one was given.
 */
export const runComponentTool = async (
  type: ComponentRequestType,
  nodes: SceneNode[],
  params: Params,
  parent?: Parent
): Promise<unknown> => {
  switch (type) {
    case "list_components":
      return listComponents(params);
    case "get_component_properties":
      return getComponentProperties(requireNode(nodes, type));
    case "create_component":
      return forEachNode(nodes, type, (node) => {
        const component = figma.createComponentFromNode(node);
        return { sourceNodeId: node.id, ...summarize(component), parentId: component.parent?.id };
      });
    case "create_component_set":
      return createComponentSet(nodes, params, parent);
    case "create_instance":
      return createInstance(nodes, params, parent);
    case "add_component_property":
      return addComponentProperty(requireNode(nodes, type), params);
    case "edit_component_property":
      return editComponentProperty(requireNode(nodes, type), params);
    case "delete_component_property":
      return deleteComponentProperty(requireNode(nodes, type), params);
    case "bind_component_property":
      return bindComponentProperty(nodes, params);
    case "set_instance_properties":
      return setInstanceProperties(nodes, params);
    case "detach_instance":
      return detachInstances(nodes);
  }
};
