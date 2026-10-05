/**
 * The guard for the bug that made the Reviews page blank in 0.1.10.
 *
 * Paperclip will not let a plugin's browser bundle reach the real "react".
 * It rewrites every `from "react"` in the bundle to a small stand-in module
 * that re-exports a hand written list of React names. A browser links an ES
 * module before it runs a single line of it, and importing a name the target
 * does not export is a link error, so one wrong name does not break one
 * feature: it stops the whole file from ever executing. The page then
 * registers nothing and the host draws a dashed placeholder.
 *
 * 0.1.9 imported nothing from "react" and was fine. 0.1.10 added `useReducer`
 * in ReviewEditor.tsx and the page has been blank since it shipped, with no
 * error a person would see and no test that could fail.
 *
 * What this file checks, and what that is worth:
 *
 * - It reads the source of every file under src/ and collects the names each
 *   one imports from "react", then compares them against FORWARDED_NAMES
 *   below. That is a copy of the host's list, so it can only be as right as
 *   the copy is. If Paperclip ever removes a name, this test keeps passing
 *   while the page breaks, which is why the list carries a comment saying
 *   where it came from.
 * - It repeats the check against dist/ui/index.js when a build is present,
 *   because that bundle is the exact thing the host links. It is skipped
 *   rather than failed when dist is missing, since `npm test` runs before
 *   `npm run build`.
 *
 * What it does NOT prove: that the page renders, that any hook is called
 * correctly, or that the host's own list is what this file says it is. It
 * proves one narrow thing, which is the one thing that broke: no file asks
 * "react" for a name the stand-in is not known to hand back.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");
const pluginDir = join(srcDir, "..");

/**
 * Every name Paperclip's React stand-in re-exports, as of host builds
 * shipping today. Eighteen hooks and helpers plus createRef. Anything else
 * imported from "react" links against nothing and takes the page down.
 *
 * Keep this in step with the host. If a name is added there, adding it here
 * is safe only once the oldest host anyone still runs also forwards it,
 * because an installed copy is not updated when a plugin is.
 */
const FORWARDED_NAMES = new Set([
  "useState",
  "useEffect",
  "useCallback",
  "useMemo",
  "useRef",
  "useContext",
  "createContext",
  "createElement",
  "Fragment",
  "Component",
  "forwardRef",
  "memo",
  "lazy",
  "Suspense",
  "StrictMode",
  "cloneElement",
  "Children",
  "isValidElement",
  "createRef",
]);

/** Every .ts and .tsx file under src/, tests included. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

interface ReactImport {
  /** Names that survive to runtime. `type` specifiers are left out: they are erased. */
  names: string[];
  /** A default or namespace import, which the stand-in is not known to answer. */
  wholeModule: string | null;
}

/**
 * Pulls apart the import clauses that end in `from "react"`. The body may
 * not contain a semicolon, which keeps the match from running past the end
 * of one statement into a later one. `from "react/jsx-runtime"` does not
 * match: that is a different module, and the host provides it separately.
 */
function reactImportsIn(text: string): ReactImport[] {
  const found: ReactImport[] = [];
  const statement = /^import\b([^;]*?)from\s*["']react["']/gm;
  for (const match of text.matchAll(statement)) {
    const clause = match[1].trim();
    // `import type { ... } from "react"` disappears at compile time.
    if (/^type\b/.test(clause)) continue;

    const braces = clause.match(/\{([\s\S]*)\}/);
    const beforeBraces = (braces ? clause.slice(0, clause.indexOf("{")) : clause).replace(/,\s*$/, "").trim();

    const names: string[] = [];
    if (braces) {
      for (const raw of braces[1].split(",")) {
        const specifier = raw.trim();
        if (specifier === "") continue;
        // `type CSSProperties` and `type X as Y` are erased too.
        if (/^type\b/.test(specifier)) continue;
        names.push(specifier.split(/\s+as\s+/)[0].trim());
      }
    }
    found.push({ names, wholeModule: beforeBraces === "" ? null : beforeBraces });
  }
  return found;
}

test("no source file imports a React name the host does not forward", () => {
  const offenders: string[] = [];
  let checked = 0;

  for (const file of sourceFiles(srcDir)) {
    const imports = reactImportsIn(readFileSync(file, "utf8"));
    for (const entry of imports) {
      checked += 1;
      const where = relative(pluginDir, file).replace(/\\/g, "/");
      for (const name of entry.names) {
        if (!FORWARDED_NAMES.has(name)) {
          offenders.push(`${where} imports ${name} from "react"`);
        }
      }
      if (entry.wholeModule !== null) {
        offenders.push(
          `${where} imports the whole module (${entry.wholeModule}) from "react"; the stand-in re-exports names only`,
        );
      }
    }
  }

  assert.equal(
    offenders.length,
    0,
    `these would fail to link against Paperclip's React stand-in and blank the page:\n  ${offenders.join("\n  ")}`,
  );
  // A parser that quietly matched nothing would pass this test for the wrong
  // reason, so insist it actually saw the imports the UI is known to have.
  assert.ok(checked >= 3, `expected to find several react imports under src/, found ${checked}`);
});

test("the reply editor drives the reducer without asking react for useReducer", () => {
  const editor = readFileSync(join(here, "ReviewEditor.tsx"), "utf8");
  // Imported names only. The word may still appear in a comment explaining
  // why it is gone, and that is not the thing that breaks the page.
  const imported = reactImportsIn(editor).flatMap((entry) => entry.names);
  assert.ok(imported.length > 0, "expected the editor to import something from react");
  assert.ok(!imported.includes("useReducer"), `the editor imports ${imported.join(", ")} from "react"`);
  // The reducer itself is still what decides every transition. If this stops
  // matching, the editor stopped using the tested state module.
  assert.match(editor, /reduceEditor\(/, "the editor still reduces over editorState.ts");
});

test("the built UI bundle asks react for nothing the host cannot give it", (t) => {
  const bundle = join(pluginDir, "dist", "ui", "index.js");
  if (!existsSync(bundle)) {
    t.skip("no build present; run npm run build to check the bundle the host actually links");
    return;
  }

  const text = readFileSync(bundle, "utf8");
  const offenders: string[] = [];
  let statements = 0;

  // esbuild emits one normalised statement per import, so the shape is
  // predictable here in a way source is not.
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"react"\s*;/g)) {
    statements += 1;
    for (const raw of match[1].split(",")) {
      const specifier = raw.trim();
      if (specifier === "") continue;
      const name = specifier.split(/\s+as\s+/)[0].trim();
      if (!FORWARDED_NAMES.has(name)) offenders.push(name);
    }
  }

  assert.equal(
    offenders.length,
    0,
    `dist/ui/index.js imports ${offenders.join(", ")} from "react"; the page will not link on an installed host`,
  );
  assert.ok(statements >= 1, "expected the bundle to import something from react");
});
