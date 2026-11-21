// Starter template for a deep module: copy this folder, or delete it.
// Root files are entry points; ./lib holds the hidden implementation.

import { buildGreeting } from "./lib/impl";

/** Greet someone by name. */
export function greet(name: string): string {
  return buildGreeting(name);
}
