import type { TargetAdapter, TargetId } from "@agentpack/schema";

/** Registry of target adapters. Core never switches on target ids directly. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, TargetAdapter>();

  register(adapter: TargetAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(target: string): TargetAdapter {
    const adapter = this.adapters.get(target);
    if (!adapter) {
      throw new Error(
        `no adapter registered for target "${target}" (registered: ${[...this.adapters.keys()].join(", ") || "none"})`,
      );
    }
    return adapter;
  }

  has(target: string): boolean {
    return this.adapters.has(target);
  }

  ids(): TargetId[] {
    return [...this.adapters.keys()] as TargetId[];
  }

  all(): TargetAdapter[] {
    return [...this.adapters.values()];
  }
}

export function createRegistry(adapters: TargetAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
