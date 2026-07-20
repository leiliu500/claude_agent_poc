/**
 * Minimal parser for the Fedline post-dispatch prompt `.md` files.
 *
 * Each prompt file is authored as Markdown with one H2 section per agent role — `## Analytics` and/or
 * `## Report`. The section BODY (everything up to the next H2 or end of file) is the prompt text handed
 * to that ephemeral agent; any prose above the first H2 (title/notes) is ignored. This keeps the prompt
 * content human-editable as Markdown while the code consumes a plain { analytics?, report? } map.
 *
 * The `.md` files are imported as raw strings — the loader is wired per tool: esbuild `loader: {".md":
 * "text"}` for the Lambda bundles, a `load` plugin in vitest.config.ts for tests, and `declare module
 * "*.md"` (src/md.d.ts) for the type-checker.
 */
export interface RolePrompts {
  analytics?: string;
  report?: string;
}

/** Extract the `## Analytics` / `## Report` section bodies from a prompt Markdown document. */
export function parseRolePrompts(md: string): RolePrompts {
  const heading = /^##[ \t]+([A-Za-z]+)[ \t]*$/gm;
  const sections: Record<string, string> = {};
  const marks = [...md.matchAll(heading)];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const name = mark[1]!.toLowerCase();
    const bodyStart = mark.index! + mark[0].length;
    const bodyEnd = i + 1 < marks.length ? marks[i + 1]!.index! : md.length;
    sections[name] = md.slice(bodyStart, bodyEnd).trim();
  }
  const out: RolePrompts = {};
  if (sections.analytics) out.analytics = sections.analytics;
  if (sections.report) out.report = sections.report;
  return out;
}
