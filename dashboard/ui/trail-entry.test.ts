import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { IntakeStepView } from "../contracts";
import { trailEntries } from "./intake-trail";
import { TrailEntryItem } from "./trail-entry";

const AT = "2026-10-22T19:04:00.000Z";
const render = (step: IntakeStepView, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement(TrailEntryItem, { entry: trailEntries([step])[0]!, ...props }));

describe("a Seguimiento menu entry", () => {
  it("is a link to the stage's page in a new tab, with its title, status and Chile date and time", () => {
    const html = render({ kind: "pr", repo: "example-org/acme-pwa", number: 12, url: "https://github.com/example-org/acme-pwa/pull/12", state: "mergeado", at: AT });
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="https://github.com/example-org/acme-pwa/pull/12"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">Pull request #12 (acme-pwa)</span>");
    expect(html).toContain(">mergeado · 22-10-2026 16:04</span>");
  });

  it("links the Slack report with the reporter's name", () => {
    const html = render({ kind: "slack", url: "https://example.slack.com/archives/C0/p1", at: AT, reporter: "Ana Pérez" });
    expect(html).toContain('href="https://example.slack.com/archives/C0/p1"');
    expect(html).toContain(">Ana Pérez · 22-10-2026 16:04</span>");
  });

  it("is text, with no link, for a stage with no page", () => {
    const held = render({ kind: "team", key: null, url: null, status: null, held: true, at: null });
    expect(held).toMatch(/^<div /);
    expect(held).not.toContain("href");
    expect(held).toContain(">Pendiente de mover a OA · -</span>");
    const unlinked = render({ kind: "slack", url: null, at: AT, reporter: null });
    expect(unlinked).not.toContain("href");
    expect(unlinked).toContain(">22-10-2026 16:04</span>");
  });

  it("passes the menu's props to its element, as the menu item's asChild needs", () => {
    const html = render({ kind: "intake", key: "OAI-7", url: "https://example.atlassian.net/browse/OAI-7", status: "Por confirmar", at: AT }, { role: "menuitem", className: "menu" });
    expect(html).toContain('role="menuitem"');
    expect(html).toMatch(/class="menu flex/);
  });
});
