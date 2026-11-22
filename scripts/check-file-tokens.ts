import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

// CODING_STANDARDS.md: "Keep every file under 5000 tokens."
// A file that big no longer fits comfortably in an agent's context next to
// everything else it needs, so the pre-commit hook rejects it.
//
// Usage:
//   tsx scripts/check-file-tokens.ts            checks the staged files
//   tsx scripts/check-file-tokens.ts a.ts b.ts  checks the named files

export const MAX_TOKENS = 5000;

// Cheap estimate: roughly four bytes per token for English text and code.
const BYTES_PER_TOKEN = 4;

const IGNORED_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)skills-lock\.json$/,
  /^drizzle\//,
  /\.snap$/,
  /^\.agents\//,
  /^\.claude\/skills\//,
  /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|mp3|mp4|webm|pdf|zip|gz|db)$/i,
];

export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function isIgnored(path: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(path));
}

export type FileSize = { path: string; bytes: number };
export type Oversized = FileSize & { tokens: number };

export function findOversized(files: FileSize[]): Oversized[] {
  return files
    .filter((file) => !isIgnored(file.path))
    .map((file) => ({ ...file, tokens: estimateTokens(file.bytes) }))
    .filter((file) => file.tokens > MAX_TOKENS);
}

export function formatReport(oversized: Oversized[]): string {
  const list = oversized
    .map(
      (file) =>
        `  ${file.path}: ~${file.tokens} tokens (${file.bytes} bytes, limit ${MAX_TOKENS})`
    )
    .join("\n");

  return `
✖ File too large: over ${MAX_TOKENS} tokens (estimated as bytes / ${BYTES_PER_TOKEN}).

${list}

CODING_STANDARDS.md says to keep every file under ${MAX_TOKENS} tokens. Split the
file before committing. Do not commit with --no-verify, and do not shrink it
by deleting comments, collapsing whitespace or minifying.

How to split it, by kind of file:

- Route (app/routes/*.tsx): keep the route as thin wiring (loader, action,
  default export). Move data access and business rules into a deep module in
  app/modules/<name>/ (copy app/modules/example/, read app/modules/README.md).
  Move large pieces of UI into components, e.g. app/components/<name>.tsx or
  a component per tab/section of the page.

- Module (app/modules/<name>/lib/*): split lib/ into one file per
  responsibility. Keep each entry point small and expose only what callers
  need. If callers need two unrelated things, add a second entry point
  rather than a barrel file.

- Test file: split by behaviour, one file per feature or entry-point
  function (e.g. tests/<feature>.test.ts). Move shared setup into a fixtures
  file in the same tests/ folder.

- Data or seed script: move each dataset into its own file and import them.

- Anything else: find the seams. Group code that changes together, and pull
  each group into its own file with a name that says what it does.

Then run \`npm run check\`, stage the new files, and commit again.
`;
}

function stagedFiles(): FileSize[] {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { encoding: "utf8" }
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => ({
      path,
      // Measure the staged content, not the working tree copy.
      bytes: Number(
        execFileSync("git", ["cat-file", "-s", `:${path}`], {
          encoding: "utf8",
        }).trim()
      ),
    }));
}

function namedFiles(paths: string[]): FileSize[] {
  return paths.map((path) => ({ path, bytes: statSync(path).size }));
}

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? namedFiles(args) : stagedFiles();
  const oversized = findOversized(files);
  if (oversized.length > 0) {
    console.error(formatReport(oversized));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
