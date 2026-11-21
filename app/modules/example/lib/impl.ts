/** Private to the example module: outsiders must go through ../index. */
export function buildGreeting(name: string): string {
  const trimmed = name.trim();
  return `Hello, ${trimmed === "" ? "stranger" : trimmed}!`;
}
