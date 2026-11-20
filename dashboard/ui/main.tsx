import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { isIntakeSurface } from "./api";
import { initializeIntakeTheme } from "./intake-theme";
import { shellPage } from "./project-model";
import { router } from "./router";

const root = document.getElementById("root");
if (!root) throw new Error("dashboard shell has no #root");
// The intake page stands alone (felipearos/ralph#459): the team opens it from
// the Slack canvas, and it makes none of the loop dashboard's reads, so it
// also works on the open intake deployment, which serves nothing else and
// answers "not found" everywhere but there. The router draws both (App gates
// them before any dashboard read), but the theme is decided here, from the
// address at load and before the first render, so the intake surface never
// flashes the dashboard's theme first.
const page = shellPage(window.location.pathname, isIntakeSurface());
if (page.kind !== "dashboard") initializeIntakeTheme();
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
