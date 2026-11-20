import {
  AgentsPage,
  App,
  BacklogOverviewPage,
  CiOverviewPage,
  FloorPage,
  IntakeRoutePage,
  LabelsOverviewPage,
  LandingPage,
  LearningsOverviewPage,
  EvalsOverviewPage,
  LoopPage,
  NotificationsOverviewPage,
  OwnershipOverviewPage,
  ReconciliationOverviewPage,
  SettingsPage,
  StatesPage,
  UsageOverviewPage,
} from "./app";
import { createRouterFor } from "./route-tree";
import { preloadPageReads } from "./use-reads";

/** The dashboard's router over the real pages; `history` defaults to the browser's (tests pass a memory one). */
export function createAppRouter(history?: Parameters<typeof createRouterFor>[1]) {
  return createRouterFor(
    {
      App,
      Agents: AgentsPage,
      Loop: LoopPage,
      overview: {
        notifications: NotificationsOverviewPage,
        usage: UsageOverviewPage,
        backlog: BacklogOverviewPage,
        ci: CiOverviewPage,
        learnings: LearningsOverviewPage,
        evals: EvalsOverviewPage,
        ownership: OwnershipOverviewPage,
        reconciliation: ReconciliationOverviewPage,
        labels: LabelsOverviewPage,
      },
      Settings: SettingsPage,
      States: StatesPage,
      Floor: FloorPage,
      Landing: LandingPage,
      Intake: IntakeRoutePage,
      preload: preloadPageReads,
    },
    history,
  );
}

export const router = createAppRouter();

// Registered so `<Link to=…>` and `useParams({ from })` are checked against this tree.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
