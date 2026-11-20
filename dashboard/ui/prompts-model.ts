/**
 * The Settings page's Prompts section (#695), as the page draws it: each
 * fragment the config names and the chosen role's rendered prompt. Pure, so
 * every state the server can answer is tested without React.
 */
import type { ProjectPromptsView, PromptFragmentView, PromptRenderView } from "../contracts";

/** What one fragment or render draws as: its text as source, or why there is none. */
export type PromptBody =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "problem"; text: string };

export interface PromptFragmentItem {
  label: string;
  path: string;
  body: PromptBody;
}

export interface PromptRenderOption {
  /** The value the role choice keys on; one render per role, so the role is unique. */
  id: string;
  label: string;
}

export interface PromptsModel {
  fragments: PromptFragmentItem[];
  options: PromptRenderOption[];
  /** The render drawn: the one chosen, else the first; null when there are none. */
  chosen: { id: string; label: string; body: PromptBody } | null;
  problems: string[];
}

export const FRAGMENT_LABEL: Record<PromptFragmentView["kind"], string> = {
  prompt: "Prompt fragment",
  coder: "Coder fragment",
  plan: "Plan",
};

export function fragmentBody(fragment: PromptFragmentView): PromptBody {
  // Missing is told first: a named file that is absent is the broken config
  // an operator must see, never an empty block.
  if (fragment.missing) return { kind: "missing" };
  if (fragment.text !== null) return { kind: "text", text: fragment.text };
  return { kind: "problem", text: fragment.problem ?? "The fragment could not be read" };
}

export function renderBody(render: PromptRenderView): PromptBody {
  if (render.prompt !== null && render.error === null) return { kind: "text", text: render.prompt };
  return { kind: "problem", text: render.error ?? "The prompt could not be rendered" };
}

export const renderLabel = (render: PromptRenderView): string => `${render.role} (as ${render.loop})`;

export function promptsModel(view: ProjectPromptsView, chosenRole: string | null): PromptsModel {
  const options = view.renders.map((render) => ({ id: render.role, label: renderLabel(render) }));
  // A choice the new snapshot no longer holds falls back to the first, not to nothing.
  const render = view.renders.find((each) => each.role === chosenRole) ?? view.renders[0] ?? null;
  return {
    fragments: view.fragments.map((fragment) => ({ label: FRAGMENT_LABEL[fragment.kind], path: fragment.path, body: fragmentBody(fragment) })),
    options,
    chosen: render === null ? null : { id: render.role, label: renderLabel(render), body: renderBody(render) },
    problems: view.problems,
  };
}
