/**
 * Inspection and editing of prototype interactions.
 *
 * Reactions are returned as Figma's own `Reaction` data. Destinations,
 * variables, and variable modes referenced by ID are additionally resolved to
 * names, and destinations to the screen and page that contain them.
 */

const DEFAULT_MAX_NODES = 5000;
const DEFAULT_MAX_SCREENS = 25;

/** Containers whose direct children are screens. */
const SCREEN_PARENT_TYPES = new Set<NodeType>(["DOCUMENT", "PAGE", "SECTION"]);

/** Navigations that put a different screen in front of the user. */
const SCREEN_NAVIGATIONS = new Set<Navigation>(["NAVIGATE", "SWAP", "OVERLAY"]);

/** Navigations that open the destination as an overlay, using its overlay settings. */
const OVERLAY_NAVIGATIONS = new Set<Navigation>(["SWAP", "OVERLAY"]);

type NodeRef = Pick<BaseNode, "id" | "name" | "type">;

type Destination =
  | (NodeRef & {
      status: "resolved";
      screen: NodeRef | null;
      page: NodeRef | null;
      overlay?: Pick<
        FramePrototypingMixin,
        "overlayPositionType" | "overlayBackground" | "overlayBackgroundInteraction"
      >;
    })
  | { status: "missing"; id: string };

type ResolvedAction =
  | Extract<Action, { type: "BACK" | "CLOSE" | "URL" }>
  | (Extract<Action, { type: "NODE" | "UPDATE_MEDIA_RUNTIME" }> & {
      destination: Destination | null;
    })
  | (Extract<Action, { type: "SET_VARIABLE" }> & {
      variable: Pick<Variable, "id" | "name" | "resolvedType"> | null;
    })
  | (Extract<Action, { type: "SET_VARIABLE_MODE" }> & {
      collectionName: string | null;
      modeName: string | null;
    })
  | {
      type: "CONDITIONAL";
      /** A null condition is the else branch. */
      conditionalBlocks: Array<{ condition: VariableData | null; actions: ResolvedAction[] }>;
    };

type LeafAction = Exclude<ResolvedAction, { type: "CONDITIONAL" }>;

type ResolvedReaction = Pick<Reaction, "trigger"> & { actions: ResolvedAction[] };

type NodeConnections = NodeRef & {
  /** True for sublayers of an instance (IDs of the form I<instance>;<child>). */
  instanceSublayer: boolean;
  /** Layer names from the screen down to this node. */
  path: string[];
  screen: NodeRef | null;
  reactions: ResolvedReaction[];
};

type ScanOptions = { maxNodes?: number; includeEmpty?: boolean };

type ScanResult = {
  root: NodeRef;
  nodesScanned: number;
  /** True when `maxNodes` was reached before the whole subtree was inspected. */
  truncated: boolean;
  connections: NodeConnections[];
};

type EdgeKind =
  "screen" | "in-screen" | "back" | "close" | "url" | "variable" | "media" | "unsupported";

type FlowEdge = {
  fromScreen: NodeRef;
  source: Omit<NodeConnections, "reactions" | "screen">;
  trigger: Reaction["trigger"];
  /** Where the action sits, e.g. `reactions[0].actions[1].conditionalBlocks[0].actions[0]`. */
  actionPath: string;
  /** Enclosing branch conditions, outermost first; null marks an else branch. */
  conditions: Array<VariableData | null>;
  action: LeafAction;
  kind: EdgeKind;
  /** For screen navigations: the destination's screen, or null when it cannot be resolved. */
  toScreen?: NodeRef | null;
  /** True when `toScreen` was already reached earlier in the trace. */
  revisit?: boolean;
};

type TraceOptions = { maxScreens?: number; maxNodesPerScreen?: number };

type FlowTrace = {
  start: NodeRef;
  /** Screens in the order first reached (breadth-first). */
  screens: Array<NodeRef & { depth: number; reachedVia: string | null }>;
  edges: FlowEdge[];
  unresolved: Array<{ edgeIndex: number; destinationId: string | null }>;
  truncated: boolean;
  /** Screens discovered but not expanded because `maxScreens` was reached. */
  pending: NodeRef[];
};

const toRef = (node: BaseNode): NodeRef => ({ id: node.id, name: node.name, type: node.type });

/** `node` and its ancestors below the nearest page or section, outermost (the screen) first. */
function screenChain(node: BaseNode): BaseNode[] {
  const chain: BaseNode[] = [];
  for (let current: BaseNode | null = node; current; current = current.parent) {
    if (SCREEN_PARENT_TYPES.has(current.type)) break;
    chain.push(current);
  }
  return chain.reverse();
}

const screenOf = (node: BaseNode): BaseNode | null => screenChain(node)[0] ?? null;

function pageOf(node: BaseNode): PageNode | null {
  for (let current: BaseNode | null = node; current; current = current.parent) {
    if (current.type === "PAGE") return current;
  }
  return null;
}

const isScreenNavigation = (action: LeafAction): action is Extract<LeafAction, { type: "NODE" }> =>
  action.type === "NODE" && SCREEN_NAVIGATIONS.has(action.navigation);

function edgeKind(action: LeafAction): EdgeKind {
  switch (action.type) {
    case "NODE":
      return isScreenNavigation(action) ? "screen" : "in-screen";
    case "BACK":
      return "back";
    case "CLOSE":
      return "close";
    case "URL":
      return "url";
    case "SET_VARIABLE":
    case "SET_VARIABLE_MODE":
      return "variable";
    case "UPDATE_MEDIA_RUNTIME":
      return "media";
    default:
      return "unsupported";
  }
}

/** Yields every non-conditional action, descending into CONDITIONAL blocks. */
function* flattenActions(
  actions: ResolvedAction[],
  path: string,
  conditions: Array<VariableData | null> = []
): Generator<{ action: LeafAction; actionPath: string; conditions: Array<VariableData | null> }> {
  for (const [i, action] of actions.entries()) {
    const actionPath = `${path}.actions[${i}]`;
    if (action.type !== "CONDITIONAL") {
      yield { action, actionPath, conditions };
      continue;
    }
    for (const [b, block] of action.conditionalBlocks.entries()) {
      yield* flattenActions(block.actions, `${actionPath}.conditionalBlocks[${b}]`, [
        ...conditions,
        block.condition,
      ]);
    }
  }
}

function memoize<T>(load: (id: string) => Promise<T>): (id: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (id) => {
    let result = cache.get(id);
    if (!result) {
      result = load(id);
      cache.set(id, result);
    }
    return result;
  };
}

/** Resolves IDs once per request, however many reactions reference them. */
class PrototypeReader {
  private readonly getNode = memoize((id) => figma.getNodeByIdAsync(id));
  private readonly getVariable = memoize((id) => figma.variables.getVariableByIdAsync(id));
  private readonly getCollection = memoize((id) =>
    figma.variables.getVariableCollectionByIdAsync(id)
  );

  async scan(
    root: BaseNode,
    { maxNodes = DEFAULT_MAX_NODES, includeEmpty = false }: ScanOptions = {}
  ): Promise<ScanResult> {
    const connections: Array<Promise<NodeConnections>> = [];
    const stack = [root];
    let nodesScanned = 0;
    while (stack.length > 0 && nodesScanned < maxNodes) {
      const node = stack.pop()!;
      nodesScanned++;
      if ("reactions" in node && (includeEmpty || node.reactions.length > 0)) {
        connections.push(this.describeNode(node));
      }
      if ("children" in node) {
        // Pushed in reverse so nodes are visited in layer order.
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      }
    }
    return {
      root: toRef(root),
      nodesScanned,
      truncated: stack.length > 0,
      connections: await Promise.all(connections),
    };
  }

  async trace(
    start: SceneNode,
    { maxScreens = DEFAULT_MAX_SCREENS, maxNodesPerScreen = DEFAULT_MAX_NODES }: TraceOptions = {}
  ): Promise<FlowTrace> {
    const startScreen = screenOf(start) ?? start;
    const trace: FlowTrace = {
      start: toRef(startScreen),
      screens: [],
      edges: [],
      unresolved: [],
      truncated: false,
      pending: [],
    };
    const reached = new Set([startScreen.id]);
    const queue = [{ screen: startScreen, depth: 0, reachedVia: null as string | null }];

    for (let next = queue.shift(); next; next = queue.shift()) {
      if (trace.screens.length >= maxScreens) {
        trace.truncated = true;
        trace.pending = [next, ...queue].map(({ screen }) => toRef(screen));
        break;
      }
      const { screen, depth, reachedVia } = next;
      const fromScreen = toRef(screen);
      trace.screens.push({ ...fromScreen, depth, reachedVia });

      const scan = await this.scan(screen, { maxNodes: maxNodesPerScreen });
      trace.truncated ||= scan.truncated;

      for (const { reactions, screen: _screen, ...source } of scan.connections) {
        for (const [r, { trigger, actions }] of reactions.entries()) {
          for (const { action, actionPath, conditions } of flattenActions(
            actions,
            `reactions[${r}]`
          )) {
            const edge: FlowEdge = {
              fromScreen,
              source,
              trigger,
              actionPath,
              conditions,
              action,
              kind: edgeKind(action),
            };
            const edgeIndex = trace.edges.push(edge) - 1;
            if (!isScreenNavigation(action)) continue;

            const { destination } = action;
            const targetId =
              destination?.status === "resolved" ? (destination.screen ?? destination).id : null;
            const target = targetId ? await this.getNode(targetId) : null;
            if (!target) {
              edge.toScreen = null;
              trace.unresolved.push({ edgeIndex, destinationId: action.destinationId });
              continue;
            }
            edge.toScreen = toRef(target);
            edge.revisit = reached.has(target.id);
            if (edge.revisit) continue;
            reached.add(target.id);
            queue.push({ screen: target, depth: depth + 1, reachedVia: source.id });
          }
        }
      }
    }
    return trace;
  }

  private async describeNode(node: SceneNode & ReactionMixin): Promise<NodeConnections> {
    const chain = screenChain(node);
    return {
      ...toRef(node),
      instanceSublayer: node.id.startsWith("I"),
      path: chain.map((ancestor) => ancestor.name),
      screen: chain.length > 0 ? toRef(chain[0]) : null,
      reactions: await Promise.all(
        node.reactions.map(async ({ trigger, action, actions }) => ({
          trigger,
          // `action` is the deprecated single-action form of `actions`.
          actions: await this.resolveActions(actions ?? (action ? [action] : [])),
        }))
      ),
    };
  }

  private resolveActions(actions: ReadonlyArray<Action>): Promise<ResolvedAction[]> {
    return Promise.all(actions.map((action) => this.resolveAction(action)));
  }

  private async resolveAction(action: Action): Promise<ResolvedAction> {
    switch (action.type) {
      case "NODE":
        return {
          ...action,
          destination: await this.resolveDestination(action.destinationId, action.navigation),
        };
      case "UPDATE_MEDIA_RUNTIME":
        return { ...action, destination: await this.resolveDestination(action.destinationId) };
      case "SET_VARIABLE": {
        const variable = action.variableId ? await this.getVariable(action.variableId) : null;
        return {
          ...action,
          variable: variable && {
            id: variable.id,
            name: variable.name,
            resolvedType: variable.resolvedType,
          },
        };
      }
      case "SET_VARIABLE_MODE": {
        const collection = action.variableCollectionId
          ? await this.getCollection(action.variableCollectionId)
          : null;
        return {
          ...action,
          collectionName: collection?.name ?? null,
          modeName: collection?.modes.find((m) => m.modeId === action.variableModeId)?.name ?? null,
        };
      }
      case "CONDITIONAL":
        return {
          type: "CONDITIONAL",
          conditionalBlocks: await Promise.all(
            action.conditionalBlocks.map(async ({ condition, actions }) => ({
              condition: condition ?? null,
              actions: await this.resolveActions(actions),
            }))
          ),
        };
      default:
        // Action types newer than the typings pass through unchanged.
        return action;
    }
  }

  private async resolveDestination(
    id: string | null | undefined,
    navigation?: Navigation
  ): Promise<Destination | null> {
    if (!id) return null;
    const node = await this.getNode(id);
    if (!node) return { status: "missing", id };
    const screen = screenOf(node);
    const page = pageOf(node);
    const destination: Destination = {
      status: "resolved",
      ...toRef(node),
      screen: screen && toRef(screen),
      page: page && toRef(page),
    };
    if (navigation && OVERLAY_NAVIGATIONS.has(navigation) && "overlayPositionType" in node) {
      destination.overlay = {
        overlayPositionType: node.overlayPositionType,
        overlayBackground: node.overlayBackground,
        overlayBackgroundInteraction: node.overlayBackgroundInteraction,
      };
    }
    return destination;
  }
}

function describeFile(node: BaseNode) {
  const page = pageOf(node);
  return {
    schemaVersion: 1,
    fileKey: figma.fileKey ?? null,
    fileName: figma.root.name,
    page: page && toRef(page),
    flowStartingPoints: page?.flowStartingPoints ?? [],
  };
}

/** Reactions on `root` and all its descendants, including instance sublayers. */
export async function scanPrototype(
  root: PageNode | SceneNode,
  options?: ScanOptions
): Promise<ScanResult> {
  if (root.type === "PAGE") await root.loadAsync();
  return new PrototypeReader().scan(root, options);
}

export async function getPrototypeConnections(root: PageNode | SceneNode, options?: ScanOptions) {
  const scan = await scanPrototype(root, options);
  return { ...describeFile(root), ...scan };
}

/**
 * Breadth-first trace of screen-to-screen navigation from the screen containing
 * `start`. Screens already reached are marked as revisits and not re-expanded.
 */
export async function tracePrototypeFlow(start: SceneNode, options?: TraceOptions) {
  const trace = await new PrototypeReader().trace(start, options);
  return { ...describeFile(start), ...trace };
}

type Params = Record<string, unknown>;

const LINK_TRIGGERS = ["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG", "AFTER_TIMEOUT"] as const;
type LinkTrigger = (typeof LINK_TRIGGERS)[number];
const LINK_NAVIGATIONS = ["NAVIGATE", "OVERLAY", "SWAP"] as const;
const SIMPLE_TRANSITIONS = ["DISSOLVE", "SMART_ANIMATE"] as const;
const DIRECTIONAL_TRANSITIONS = ["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"] as const;
const DIRECTIONS = ["LEFT", "RIGHT", "TOP", "BOTTOM"] as const;
const EASINGS = [
  "EASE_IN",
  "EASE_OUT",
  "EASE_IN_AND_OUT",
  "LINEAR",
  "GENTLE",
  "QUICK",
  "BOUNCY",
  "SLOW",
] as const;

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.some((entry) => entry === value);

type ReactionNode = SceneNode & ReactionMixin;

const requireReactionNode = (node: SceneNode, tool: string): ReactionNode => {
  if (!("setReactionsAsync" in node)) {
    throw new Error(`${tool}: ${node.type} nodes cannot have prototype interactions: ${node.id}`);
  }
  return node;
};

/** Applies `fn` to each node; a batch reports per-node errors instead of aborting. */
async function forEachNode<T>(
  nodes: SceneNode[],
  tool: string,
  fn: (node: SceneNode) => Promise<T>
) {
  if (nodes.length === 0) {
    throw new Error(`nodeId or nodeIds is required for ${tool}`);
  }
  if (nodes.length === 1) {
    return { results: [await fn(nodes[0])] };
  }
  const results: unknown[] = [];
  for (const node of nodes) {
    try {
      results.push(await fn(node));
    } catch (err) {
      results.push({ nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results };
}

function buildTrigger(params: Params, tool: string): Trigger {
  const { trigger, timeoutSeconds } = params;
  if (!isOneOf(LINK_TRIGGERS, trigger)) {
    throw new Error(`${tool}: trigger must be one of ${LINK_TRIGGERS.join(", ")}`);
  }
  if (trigger !== "AFTER_TIMEOUT") return { type: trigger };
  if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) {
    throw new Error(`${tool}: AFTER_TIMEOUT needs timeoutSeconds greater than 0`);
  }
  return { type: trigger, timeout: timeoutSeconds };
}

function buildTransition(params: Params, tool: string): Transition | null {
  const { transition, direction, durationSeconds, easing } = params;
  if (transition === undefined || transition === "INSTANT") return null;
  const duration = typeof durationSeconds === "number" ? durationSeconds : 0.3;
  const easingType = isOneOf(EASINGS, easing) ? easing : "EASE_OUT";
  if (isOneOf(SIMPLE_TRANSITIONS, transition)) {
    return { type: transition, duration, easing: { type: easingType } };
  }
  if (isOneOf(DIRECTIONAL_TRANSITIONS, transition)) {
    if (!isOneOf(DIRECTIONS, direction)) {
      throw new Error(`${tool}: ${transition} needs direction ${DIRECTIONS.join(", ")}`);
    }
    return {
      type: transition,
      direction,
      matchLayers: false,
      duration,
      easing: { type: easingType },
    };
  }
  throw new Error(`${tool}: unknown transition ${String(transition)}`);
}

async function buildAction(source: SceneNode, params: Params, tool: string): Promise<Action> {
  const { action, destinationId, url, openInNewTab } = params;
  if (action === "BACK" || action === "CLOSE") return { type: action };
  if (action === "URL") {
    if (typeof url !== "string") throw new Error(`${tool}: URL action needs url`);
    return { type: "URL", url, openInNewTab: openInNewTab !== false };
  }
  if (!isOneOf(LINK_NAVIGATIONS, action)) {
    throw new Error(`${tool}: action must be NAVIGATE, OVERLAY, SWAP, BACK, CLOSE or URL`);
  }
  if (typeof destinationId !== "string") {
    throw new Error(`${tool}: ${action} needs destinationId`);
  }
  const destination = await figma.getNodeByIdAsync(destinationId);
  if (!destination || destination.type === "DOCUMENT" || destination.type === "PAGE") {
    throw new Error(`${tool}: destination not found: ${destinationId}`);
  }
  // Prototype destinations are screens: top-level frames on the source's own page.
  if (!destination.parent || !SCREEN_PARENT_TYPES.has(destination.parent.type)) {
    throw new Error(
      `${tool}: destination "${destination.name}" (${destination.id}) is not a top-level frame`
    );
  }
  if (pageOf(destination) !== pageOf(source)) {
    throw new Error(`${tool}: destination "${destination.name}" is on a different page`);
  }
  return {
    type: "NODE",
    destinationId: destination.id,
    navigation: action,
    transition: buildTransition(params, tool),
  };
}

const sameTrigger = (reaction: Reaction, type: LinkTrigger): boolean =>
  reaction.trigger?.type === type;

/**
 * Adds an interaction to each node, replacing any existing interaction with the
 * same trigger type, as Figma's prototype panel does.
 */
export async function setPrototypeLink(nodes: SceneNode[], params: Params) {
  const tool = "set_prototype_link";
  const trigger = buildTrigger(params, tool);
  const triggerType = trigger.type;
  if (!isOneOf(LINK_TRIGGERS, triggerType)) {
    throw new Error(`${tool}: unsupported trigger ${triggerType}`);
  }
  return forEachNode(nodes, tool, async (node) => {
    const target = requireReactionNode(node, tool);
    const action = await buildAction(target, params, tool);
    const previous = target.reactions;
    try {
      await target.setReactionsAsync([
        ...previous.filter((reaction) => !sameTrigger(reaction, triggerType)),
        { trigger, actions: [action] },
      ]);
    } catch (err) {
      // Figma only says "Reaction at index N was invalid"; name the combination instead.
      const transition = action.type === "NODE" ? (action.transition?.type ?? "INSTANT") : "";
      const dragHint =
        triggerType === "ON_DRAG"
          ? " ON_DRAG only allows BACK, CLOSE, or NAVIGATE with SMART_ANIMATE or a directional transition."
          : "";
      throw new Error(
        `${tool}: Figma rejected ${triggerType} + ${String(params.action)} ${transition} on ${target.id}.${dragHint} (${err instanceof Error ? err.message : String(err)})`
      );
    }
    return { nodeId: target.id, nodeName: target.name, previous, applied: target.reactions };
  });
}

/** Removes every interaction, or only those with the given trigger type. */
export async function removePrototypeLinks(nodes: SceneNode[], params: Params) {
  const tool = "remove_prototype_links";
  if (params.confirm !== true) {
    throw new Error(`${tool} requires confirm: true`);
  }
  const { trigger } = params;
  if (trigger !== undefined && !isOneOf(LINK_TRIGGERS, trigger)) {
    throw new Error(`${tool}: trigger must be one of ${LINK_TRIGGERS.join(", ")}`);
  }
  return forEachNode(nodes, tool, async (node) => {
    const target = requireReactionNode(node, tool);
    const previous = target.reactions;
    const kept = trigger === undefined ? [] : previous.filter((r) => !sameTrigger(r, trigger));
    await target.setReactionsAsync([...kept]);
    return {
      nodeId: target.id,
      nodeName: target.name,
      removedCount: previous.length - kept.length,
      previous,
      applied: target.reactions,
    };
  });
}

/** Adds, renames or removes the flow starting point on a top-level frame. */
export function setFlowStartingPoint(node: SceneNode, params: Params) {
  const tool = "set_flow_starting_point";
  const page = pageOf(node);
  if (!page || !node.parent || !SCREEN_PARENT_TYPES.has(node.parent.type)) {
    throw new Error(`${tool}: "${node.name}" (${node.id}) is not a top-level frame`);
  }
  const previous = page.flowStartingPoints;
  const others = previous.filter((flow) => flow.nodeId !== node.id);
  if (params.remove === true) {
    page.flowStartingPoints = others;
  } else {
    const existing = previous.find((flow) => flow.nodeId === node.id);
    const name =
      typeof params.name === "string"
        ? params.name
        : (existing?.name ?? `Flow ${others.length + 1}`);
    page.flowStartingPoints = [...others, { nodeId: node.id, name }];
  }
  return { pageId: page.id, previous, applied: page.flowStartingPoints };
}
