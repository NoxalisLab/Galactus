// Fixture for the Lezer outline (TypeScript).
export interface Options {
  debug: boolean;
}

export class Engine {
  private started = false;

  start(o: Options): void {
    this.started = o.debug;
  }
}

export function boot(o: Options): Engine {
  const e = new Engine();
  e.start(o);
  return e;
}

const VERSION = "1.0.0";
