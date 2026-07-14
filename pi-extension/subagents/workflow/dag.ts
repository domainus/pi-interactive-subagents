import type { TaskNode } from "./types.ts";
import { computeWorkflowDepths } from "./schema.ts";

export interface CompiledDag { readonly nodes: readonly TaskNode[]; readonly byId: ReadonlyMap<string, TaskNode>; readonly depths: Readonly<Record<string, number>>; readonly order: readonly string[]; readonly dependents: ReadonlyMap<string, readonly string[]>; }
function immutableMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source); let wrapper!: ReadonlyMap<K, V>;
  wrapper = Object.freeze({
    get size() { return map.size; }, get: (key: K) => map.get(key), has: (key: K) => map.has(key),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => { for (const [key, value] of map) callback.call(thisArg, value, key, wrapper); },
    entries: () => map.entries(), keys: () => map.keys(), values: () => map.values(), [Symbol.iterator]: () => map[Symbol.iterator](),
  } as ReadonlyMap<K, V>); return wrapper;
}
export function compileDag(nodes: readonly TaskNode[]): CompiledDag {
  const byIdMutable = new Map<string, TaskNode>(); for (const node of nodes) { if (byIdMutable.has(node.id)) throw new Error(`duplicate node ID: ${node.id}`); byIdMutable.set(node.id, node); }
  const depths = computeWorkflowDepths(nodes); const order: string[] = []; const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string) => { if (state.get(id) === 1) throw new Error("workflow dependency cycle detected"); if (state.get(id) === 2) return; const node = byIdMutable.get(id); if (!node) throw new Error(`unknown dependency: ${id}`); state.set(id, 1); for (const dep of [...new Set([...(node.dependsOn ?? []), ...(node.gate?.dependsOn ?? [])])].sort()) visit(dep); state.set(id, 2); order.push(id); };
  for (const node of nodes) visit(node.id);
  const dependentsMutable = new Map<string, string[]>(); for (const node of nodes) for (const dep of new Set([...(node.dependsOn ?? []), ...(node.gate?.dependsOn ?? [])])) { const list = dependentsMutable.get(dep) ?? []; list.push(node.id); dependentsMutable.set(dep, list); }
  const dependents = new Map<string, readonly string[]>(); for (const [id, list] of dependentsMutable) dependents.set(id, Object.freeze(list.sort()));
  return Object.freeze({ nodes: Object.freeze([...nodes]), byId: immutableMap(byIdMutable), depths: Object.freeze({ ...depths }), order: Object.freeze(order), dependents: immutableMap(dependents) });
}
export const topologicalSort = (nodes: readonly TaskNode[]): readonly TaskNode[] => { const dag = compileDag(nodes); return dag.order.map((id) => dag.byId.get(id)!); };
export const validateDag = compileDag;
