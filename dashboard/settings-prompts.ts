/**
 * The Settings page's Prompts section (#695): the prompt fragments the
 * project's config names and the prompt `models.ts` renders for each role on
 * the roster.
 *
 * Every read goes through the agents adapter and degrades into the view, as
 * `projectSettings` does: a missing fragment or a render that dies is what an
 * operator opens this section to see, so it is drawn, never thrown.
 */
import type { AgentsDeps } from "./agents";
import type { LoopRole, ProjectPromptsView, PromptFragmentView, PromptRenderView } from "./contracts";

/** The config's fragment keys in the order the section lists them. */
const FRAGMENT_KINDS = ["prompt", "coder", "plan"] as const;

/** Build the Prompts section of the project; never throws for a failed read. */
export async function projectPrompts(deps: AgentsDeps): Promise<ProjectPromptsView> {
  const { agents } = deps;
  const config = await agents.readConfig();
  if (!config.ok) return { fragments: [], renders: [], problems: config.problems ?? [config.why] };

  const fragments: PromptFragmentView[] = [];
  for (const kind of FRAGMENT_KINDS) {
    const path = config.value.fragments[kind];
    // A fragment the config does not name is not missing: the harness then
    // renders without it, which is a choice and not a fault.
    if (path === null) continue;
    const read = agents.readProjectFile(path);
    if (read.ok) fragments.push({ kind, path, text: read.value, missing: false, problem: null });
    else fragments.push({ kind, path, text: null, missing: read.missing, problem: read.missing ? null : read.why });
  }

  const { roster, rosterWhy } = config.value;
  if (roster === null) {
    return { fragments, renders: [], problems: [`cannot read the project's roster: ${rosterWhy ?? "no reason was reported"}`] };
  }

  // A render needs a loop name, and the loops of one role share the harness
  // prompt and the project's fragments, so the first loop holding a role
  // stands for it; a loop with a lineup block of its own differs only in its
  // model lines. A process each, concurrently.
  const firsts = new Map<LoopRole, string>();
  for (const loop of roster) if (!firsts.has(loop.role)) firsts.set(loop.role, loop.name);
  const renders = await Promise.all(
    [...firsts].map(async ([role, loop]): Promise<PromptRenderView> => {
      const rendered = await agents.renderPrompt(role, loop);
      return rendered.ok ? { role, loop, prompt: rendered.value, error: null } : { role, loop, prompt: null, error: rendered.why };
    }),
  );

  return { fragments, renders, problems: [] };
}
