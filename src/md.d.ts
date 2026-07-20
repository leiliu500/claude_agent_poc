/**
 * Import `.md` files as their raw text content, e.g. `import prompt from "./x.md"`.
 *
 * The actual loading is wired per tool: esbuild `loader: { ".md": "text" }` (Lambda bundles), a `load`
 * plugin in vitest.config.ts (tests), and this ambient declaration for the type-checker. Used for the
 * Fedline post-dispatch prompts (src/apps/fedline/prompts/postdispatch/*.md).
 */
declare module "*.md" {
  const content: string;
  export default content;
}
