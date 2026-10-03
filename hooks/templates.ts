// The two templates that shape a handoff. These are the built-in defaults. On a session's
// start the mod writes each one to its configured path if no file is there yet, then reads
// the file at every handoff, so editing that file changes the brief. Delete it to get the
// current default back.

// What Haiku is told to write. Each "## " heading is a section of the brief; the brief counts
// as valid when Haiku's reply holds at least one of them. Keep "## Last Request from the User"
// (and its Status line) if you want the PRIORITY directive in the instructions.
export const DEFAULT_BRIEF_TEMPLATE = `You are writing a handoff brief for an AI assistant that will continue this Claude Code session in a fresh context. Above are facts extracted from the session's tool calls, then the conversation (tool output abbreviated; "system signal" entries are harness messages, never the user). Output only the brief, with these sections in this order. Omit a section if it would be empty. Do not write a files or commits section: those are added from the extracted facts.

## Handoff Confidence
One line: High / Medium / Low, and why.

## Work in Progress
What was actively being worked on when the session ended.

## Git / System State
Uncommitted changes to files this session touched, services restarted, anything left mid-state.

## Decisions Made
Concrete choices: values, file paths, approach names.

## Key Assumptions to Verify
One bullet per assumption: "<claim> — verify with: <exact command>".

## Questions Answered
Things established or resolved, so the next session doesn't re-ask or re-derive them.

## Open Questions
Anything unresolved or pending a decision.

## Dead Ends
Approaches tried and ruled out, and why.

## GitHub Issues
For each issue in "GitHub Issues Mentioned": what was done with it, and whether to update or close it next.

## Last Request from the User
Copy "Last Real User Message" verbatim. Then "Status: Answered / Partially answered / Not answered". If not fully answered: "Context needed: <file, command, or issue to check>".

## Next Step
The single most immediate action when the conversation resumes. If the last request is unanswered, answer it.
`

// What the fresh session is told to do with the brief. It opens the brief file.
// {{#priority}}...{{/priority}} shows only when the last request is not fully answered;
// {{^priority}}...{{/priority}} shows only when it is.
export const DEFAULT_INSTRUCTIONS_TEMPLATE = `## Instructions
{{#priority}}
**PRIORITY: The "Last Request from the User" section below is not yet answered. Answer that request as your first action.**
{{/priority}}

This turn was triggered by the system, not by a user. No one asked a question. Do not summarize or restate this brief; the user can read it themselves.
{{#priority}}Do the PRIORITY request and nothing else.{{/priority}}
{{^priority}}If the brief includes in-progress or pending work, continue that work immediately. Otherwise reply with at most two sentences: confirm you have the context and are ready to continue.{{/priority}}

**You MUST produce a text response before ending your turn, even if every tool call returned empty results.**
`

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
