/**
 * Cheap, dependency-free cold-start gate for the TypeScript language service.
 * Keep this outside client.ts so restoring a Rust, Python or notes workspace
 * never imports the 9 MB TypeScript bundle merely to decide it is irrelevant.
 */
export function shouldLoadTsIntel(rootEntryNames: readonly string[]): boolean {
  return rootEntryNames.includes("tsconfig.json") || rootEntryNames.includes("package.json");
}
