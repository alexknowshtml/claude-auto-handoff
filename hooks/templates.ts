// Helpers for the two templates that shape a handoff. The templates themselves are markdown
// files: the defaults ship in the mod's templates/ folder, and on a session's start the mod
// copies each one to its configured path if no file is there yet. Every handoff reads the
// copy, so editing it changes the brief. Delete it to get the current default back.

/** Fills {{#name}}...{{/name}} (shown when set) and {{^name}}...{{/name}} (shown when not). */
export function renderTemplate(template: string, flags: Record<string, boolean>): string {
  return template
    .replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_m, kind: string, name: string, body: string) => (kind === '#') === Boolean(flags[name]) ? body : '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The "## " headings a template asks for, as Haiku should write them. */
export function sectionHeadings(template: string): string[] {
  return [...template.matchAll(/^## (.+)$/gm)].map(m => `## ${m[1]!.trim()}`)
}
