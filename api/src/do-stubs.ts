import type { Bindings } from "./types";

export function getConductor(env: Bindings): DurableObjectStub {
  const id = env.CONDUCTOR.idFromName("main");
  return env.CONDUCTOR.get(id);
}
