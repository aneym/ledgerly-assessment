import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const options: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
};
// TypeScript removes type-only imports. Walk the resulting runtime graph so re-exporting
// a Node dependency from a package barrel is caught even when a unit test runs in Node.
function nodeDependencies(entry: string) {
  const seen = new Set<string>();
  const found: string[] = [];
  function visit(file: string, chain: string[]) {
    if (seen.has(file)) return;
    seen.add(file);
    const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: options,
    }).outputText;
    const syntax = ts.createSourceFile(
      file,
      emitted,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of syntax.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const name = specifier.text;
      if (name.startsWith("node:") || builtinModules.includes(name)) {
        found.push([...chain, name].join(" -> "));
        continue;
      }
      const dependency =
        name === "@ledgerly/core"
          ? resolve(root, "packages/core/src/index.ts")
          : name.startsWith("@ledgerly/core/")
            ? resolve(root, "packages/core/src", `${name.slice("@ledgerly/core/".length)}.ts`)
            : name.startsWith(".")
              ? ts.resolveModuleName(name, file, options, ts.sys).resolvedModule?.resolvedFileName
              : undefined;
      if (dependency) visit(dependency, [...chain, name]);
    }
  }
  visit(entry, [entry.slice(root.length)]);
  return found;
}
it.each([
  "lib/operator/format.ts",
  "lib/seller/ledger.ts",
  "components/seller/PayoutsPanel.tsx",
  "components/seller/ProductForm.tsx",
  "components/buyer/FeeSplit.tsx",
  "lib/operator/fixtures.ts",
])("keeps %s runtime dependencies browser-safe", (file) => {
  expect(nodeDependencies(resolve(root, "apps/web/src", file))).toEqual([]);
});
