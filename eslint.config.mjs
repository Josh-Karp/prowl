import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".git/**",
      ".husky/_/**",
      ".playwright-mcp/**",
      "logs/**",
      "docs/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    plugins: {
      local: {
        rules: {
          "type-order": {
            meta: {
              type: "layout",
              schema: [],
              messages: {
                order:
                  "Place type imports first, then value imports, then type declarations, then other code.",
                blankLine:
                  "Separate type imports from other code with a blank line.",
              },
            },
            create(context) {
              return {
                Program(program) {
                  let highestGroup = 0;
                  let previous;
                  for (const node of program.body) {
                    const declaration = node.declaration ?? node;
                    const group =
                      node.type === "ImportDeclaration"
                        ? node.importKind === "type"
                          ? 0
                          : 1
                        : [
                              "TSTypeAliasDeclaration",
                              "TSInterfaceDeclaration",
                            ].includes(declaration.type)
                          ? 2
                          : 3;
                    if (group < highestGroup)
                      context.report({ node, messageId: "order" });
                    if (
                      previous?.type === "ImportDeclaration" &&
                      previous.importKind === "type" &&
                      group !== 0 &&
                      !context.sourceCode.lines
                        .slice(previous.loc.end.line, node.loc.start.line - 1)
                        .some((line) => line.trim() === "")
                    )
                      context.report({ node, messageId: "blankLine" });
                    highestGroup = Math.max(highestGroup, group);
                    previous = node;
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportSpecifier[importKind='type']",
          message:
            "Use a separate import type declaration at the top of the file.",
        },
      ],
      "local/type-order": "error",
    },
  },
  prettier,
);
