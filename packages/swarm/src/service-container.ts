export class SwarmServiceContainer {
  private readonly services = new Map<symbol, unknown>();

  bind<T>(typeSymbol: symbol, instance: T): this {
    this.services.set(typeSymbol, instance);
    return this;
  }

  get<T>(typeSymbol: symbol): T {
    if (!this.services.has(typeSymbol)) {
      throw new Error(
        `Unable to retrieve a Swarm service for "${typeSymbol.toString()}".`,
      );
    }
    return this.services.get(typeSymbol) as T;
  }

  tryGet<T>(typeSymbol: symbol): T | undefined {
    return this.services.has(typeSymbol)
      ? this.services.get(typeSymbol) as T
      : undefined;
  }

  update<T>(typeSymbol: symbol, updater: (instance: T) => T): this {
    return this.bind(typeSymbol, updater(this.get<T>(typeSymbol)));
  }
}

let processContainer: SwarmServiceContainer | undefined;

export function getSwarmServiceContainer(): SwarmServiceContainer {
  processContainer ??= new SwarmServiceContainer();
  return processContainer;
}
