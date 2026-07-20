import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Load `.md` imports as raw text (mirrors the esbuild `loader: { ".md": "text" }` used for the Lambda
 * bundles), so the Fedline post-dispatch prompt files import identically under the test runner.
 */
const markdownAsText = {
  name: "md-as-text",
  enforce: "pre" as const,
  load(id: string) {
    if (id.endsWith(".md")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [markdownAsText],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
