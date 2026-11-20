/**
 * The clerk's intake page (felipearos/ralph#459), at `/p/:project/intake`.
 *
 * It stands on its own, with its own report navigation: the team opens
 * it from the Slack canvas's "Ver todo el backlog" line, and on the open
 * intake deployment it is the only page there is. It reads three routes and
 * nothing else: `/api/intake` (the tickets, open), `/api/intake/session` and
 * `/api/intake/metrics` (the operator's numbers). The server decides who may
 * read the metrics; this page only asks, and shows the password form when the
 * answer is no.
 */
import { useEffect, useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight, BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, GitBranch, Inbox, Kanban } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type {
  IntakeLinkView,
  IntakeMetricsRow,
  IntakeMetricsView,
  IntakeParticipationRow,
  IntakePrecisionCorrection,
  IntakePrecisionFieldRow,
  IntakePrecisionView,
  IntakePrecisionWeekRow,
  IntakeTicketView,
  IntakeView,
} from "../contracts";
import { CHILE_TIME_LABEL, chileDate, chileDateTime, chileTime, instantMs } from "./chile-time";
import {
  ALL,
  applyFilters,
  assigneeLabel,
  changesOf,
  difficultyLabel,
  duration,
  fieldLabel,
  filterOptions,
  NO_FILTERS,
  optionLabel,
  overridesOf,
  percent,
  priorityLabel,
  reporterLabel,
  modeNotice,
  overrideValue,
  testReports,
  TICKET_TABS,
  ticketNumbers,
  ticketsOf,
  valuableRate,
  type IntakeFilters,
  type IntakeTab,
} from "./intake-model";
import { pagePath } from "./project-model";
import { CommandNotice, send } from "./command";
import type { CommandError } from "./command-model";
import { latestRank, latestStep, stepLabel, trailEntries } from "./intake-trail";
import { TrailEntryItem } from "./trail-entry";
import { IntakeThemeSelector } from "./intake-theme";
import { intakeSignal } from "./intake-signal-model";
import { IntakeSignalIcon } from "./intake-signal";
import { Tip } from "./tip";
import type { Read } from "./query-reads";
import { useIntake, useIntakeMetrics, useIntakeSession } from "./use-reads";

/**
 * The data a read shows: the last good answer, kept through a failed refresh,
 * so a blip at the minute's poll does not blank the page to an error.
 */
function shown<T>(read: Read<T>): T | null {
  return read.state === "loading" ? null : read.data;
}

/** A refresh failed but earlier data is still on screen: say so, quietly. */
function Stale<T>({ read }: { read: Read<T> }) {
  if (read.state !== "error" || read.data === null) return null;
  return <p className="text-xs text-muted-foreground">No se pudo actualizar: {read.message}</p>;
}

/* ------------------------------------------------------------ data table */

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * A shadcn table over TanStack Table: every column sorts on a header click,
 * and the rows come a page at a time. `resetKey` sends it back to the first
 * page when the filters change; the minute's refresh keeps the page, since
 * the data array is new on every render and TanStack's own reset would fire.
 */
function DataTable<T>({ columns, data, empty, resetKey }: { columns: ColumnDef<T>[]; data: T[]; empty: string; resetKey?: string }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const table = useReactTable({
    data,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
  useEffect(() => setPagination((current) => ({ ...current, pageIndex: 0 })), [resetKey]);
  const pageCount = Math.max(1, table.getPageCount());
  // A refresh that leaves fewer rows must not strand the table past its last page.
  useEffect(() => {
    if (pagination.pageIndex >= pageCount) setPagination((current) => ({ ...current, pageIndex: pageCount - 1 }));
  }, [pagination.pageIndex, pageCount]);
  const first = data.length === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const last = Math.min(data.length, (pagination.pageIndex + 1) * pagination.pageSize);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden border [&>[data-slot=table-container]]:min-h-0 [&>[data-slot=table-container]]:overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id} className="whitespace-nowrap">
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-6 text-center text-muted-foreground">
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {/* A table that fits on the smallest page needs no pager. */}
      {data.length > PAGE_SIZES[0]! && (
        <nav aria-label="Paginación" className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {first}–{last} de {data.length}
          </span>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 whitespace-nowrap">
              Filas por página
              <Select value={String(pagination.pageSize)} onValueChange={(value) => table.setPageSize(Number(value))}>
                <SelectTrigger size="sm" className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <span className="whitespace-nowrap tabular-nums">
              Página {pagination.pageIndex + 1} de {pageCount}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" aria-label="Primera página" disabled={!table.getCanPreviousPage()} onClick={() => table.firstPage()}>
                <ChevronsLeft />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Página anterior" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Página siguiente" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
                <ChevronRight />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Última página" disabled={!table.getCanNextPage()} onClick={() => table.lastPage()}>
                <ChevronsRight />
              </Button>
            </div>
          </div>
        </nav>
      )}
    </div>
  );
}

const external = { target: "_blank", rel: "noreferrer noopener" } as const;

/** Keep the table compact while leaving the complete summary available on click or Enter. */
function TicketSummary({ ticket }: { ticket: IntakeTicketView }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Leer resumen completo de ${ticket.key}: ${ticket.summary}`}
          className="block w-64 cursor-pointer text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-80"
        >
          <span className="block truncate">{ticket.summary}</span>
        </button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="flex max-h-[85dvh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Resumen del reporte</DialogTitle>
          <DialogDescription>{ticket.key}</DialogDescription>
        </DialogHeader>
        <p className="min-h-0 overflow-y-auto whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{ticket.summary}</p>
        <DialogFooter>
          <Button variant="outline" asChild>
            <a href={ticket.url} {...external}>Abrir ticket</a>
          </Button>
          <DialogClose asChild>
            <Button>Cerrar</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PRIORITY_ORDER = ["Highest", "High", "Medium", "Low", "Lowest", "Sin Prioridad"];
const DIFFICULTY_ORDER = ["easy", "medium", "hard"];
const ranked = (order: string[], value: string | null): number => {
  const at = value === null ? -1 : order.indexOf(value);
  return at === -1 ? order.length : at;
};

/**
 * The Seguimiento cell: the furthest stage the report reached, opening a
 * menu of every stage it went through, oldest first. A ticket with no trail
 * (a snapshot from before it was recorded) falls back to its own link.
 */
function Trail({ ticket }: { ticket: IntakeTicketView }) {
  const entries = trailEntries(ticket.trail);
  const signal = intakeSignal(ticket);
  const ownership = ticket.assignee === null ? null : `Asignado a ${ticket.assignee === "agente" ? "un agente" : "una persona"}`;
  const hint = [signal.label, signal.detail, ownership].filter(Boolean).join("\n");
  if (entries.length === 0) {
    return (
      <Tip content={hint}>
        <a className="inline-flex items-center gap-2 font-medium whitespace-nowrap underline-offset-4 hover:underline" href={ticket.url} aria-label={`${ticket.key}. ${signal.label}`} {...external}>
          {ticket.key}
          <IntakeSignalIcon state={signal.state} />
        </a>
      </Tip>
    );
  }
  return (
    <DropdownMenu>
      <Tip content={hint}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" className="gap-2 normal-case tracking-normal" aria-label={`${stepLabel(latestStep(ticket.trail))}. ${signal.label}. Ver seguimiento`}>
            {stepLabel(latestStep(ticket.trail))}
            <IntakeSignalIcon state={signal.state} />
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent className="w-auto max-w-sm">
        <DropdownMenuLabel className="flex flex-col gap-0.5 normal-case tracking-normal">
          <span>{signal.label}</span>
          {ownership && <span className="font-normal text-muted-foreground">{ownership}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {entries.map((entry) => (
          <DropdownMenuItem key={entry.id} asChild>
            <TrailEntryItem entry={entry} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Tickets cell: every number the ticket goes by (OAI, OA, PRs), each a link. */
function TicketNumbers({ ticket }: { ticket: IntakeTicketView }) {
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap">
      {ticketNumbers(ticket).map((number) =>
        number.href === null ? (
          <span key={number.label}>{number.label}</span>
        ) : (
          <a key={number.label} className="underline-offset-4 hover:underline" href={number.href} {...external}>
            {number.label}
          </a>
        ),
      )}
    </div>
  );
}

/** A date column sorts by the whole instant, so two reports on one day keep their order. */
const byInstant =
  (field: "created" | "closedAt") =>
  (a: { original: IntakeTicketView }, b: { original: IntakeTicketView }): number =>
    instantMs(a.original[field]) - instantMs(b.original[field]);

/** The column's header, saying which clock it reads on hover. */
const chileHeader = (text: string) => () => <span title={CHILE_TIME_LABEL}>{text}</span>;

const TICKET_COLUMNS: ColumnDef<IntakeTicketView>[] = [
  {
    id: "trail",
    header: "Seguimiento",
    accessorFn: (ticket) => stepLabel(latestStep(ticket.trail)),
    // Furthest stage first when sorted descending; the label breaks ties.
    sortingFn: (a, b) => latestRank(a.original.trail) - latestRank(b.original.trail) || stepLabel(latestStep(a.original.trail)).localeCompare(stepLabel(latestStep(b.original.trail))),
    cell: ({ row }) => <Trail ticket={row.original} />,
  },
  {
    id: "numbers",
    header: "Tickets",
    accessorFn: (ticket) => ticketNumbers(ticket).map((number) => number.label).join(" "),
    cell: ({ row }) => <TicketNumbers ticket={row.original} />,
  },
  { accessorKey: "summary", header: "Resumen", cell: ({ row }) => <TicketSummary ticket={row.original} /> },
  { accessorKey: "app", header: "App", cell: ({ row }) => row.original.app ?? "-" },
  { accessorKey: "type", header: "Tipo", cell: ({ row }) => row.original.type ?? "-" },
  {
    accessorKey: "priority",
    header: "Prioridad",
    sortingFn: (a, b) => ranked(PRIORITY_ORDER, a.original.priority) - ranked(PRIORITY_ORDER, b.original.priority),
    cell: ({ row }) => priorityLabel(row.original.priority),
  },
  {
    accessorKey: "difficulty",
    header: "Dificultad",
    sortingFn: (a, b) => ranked(DIFFICULTY_ORDER, a.original.difficulty) - ranked(DIFFICULTY_ORDER, b.original.difficulty),
    cell: ({ row }) => difficultyLabel(row.original.difficulty),
  },
  {
    accessorKey: "storyPoints",
    header: "Puntos",
    sortUndefined: "last",
    cell: ({ row }) => <span className="tabular-nums">{row.original.storyPoints ?? "-"}</span>,
  },
  { accessorKey: "assignee", header: "Asignado a", cell: ({ row }) => assigneeLabel(row.original.assignee) },
  { accessorKey: "reporter", header: "Reportado por", cell: ({ row }) => row.original.reporter ?? "-" },
  {
    accessorKey: "created",
    header: chileHeader("Fecha"),
    sortingFn: byInstant("created"),
    cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{chileDate(row.original.created)}</span>,
  },
  {
    // The same instant as Fecha: sorting either sorts by the whole timestamp.
    id: "createdTime",
    accessorFn: (ticket) => ticket.created,
    header: chileHeader("Hora"),
    sortingFn: byInstant("created"),
    cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{chileTime(row.original.created)}</span>,
  },
  {
    accessorKey: "closedAt",
    header: chileHeader("Cerrado"),
    sortingFn: byInstant("closedAt"),
    cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{chileDate(row.original.closedAt)}</span>,
  },
];

/* --------------------------------------------------------------- tickets */

function FilterSelect({
  label,
  field,
  value,
  options,
  onChange,
}: {
  label: string;
  field: "status" | "app" | "difficulty" | "assignee";
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5 text-xs whitespace-nowrap text-muted-foreground xl:flex-row xl:items-center xl:gap-2">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-full min-w-0 xl:data-[size=sm]:h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[ALL, ...options].map((option) => (
            <SelectItem key={option} value={option}>
              {optionLabel(field, option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function Tickets({ view }: { view: IntakeView }) {
  const [tab, setTab] = useState<IntakeTab>("recientes");
  const [filters, setFilters] = useState<IntakeFilters>(NO_FILTERS);
  const options = useMemo(() => filterOptions(view.tickets), [view.tickets]);
  const set = (field: keyof IntakeFilters) => (value: string) => setFilters((current) => ({ ...current, [field]: value }));
  // A search looks for one ticket whatever its state, so starting one shows every tab's rows.
  const search = (value: string) => {
    if (filters.text.trim() === "" && value.trim() !== "") setTab("todos");
    set("text")(value);
  };
  const filtered = useMemo(() => applyFilters(view.tickets, filters), [view.tickets, filters]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <div className="grid shrink-0 grid-cols-2 items-end gap-x-3 gap-y-2 lg:grid-cols-4 xl:grid-cols-[minmax(12rem,2fr)_repeat(4,minmax(0,1fr))_auto]">
        <label className="col-span-2 flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground xl:col-span-1 xl:flex-row xl:items-center xl:gap-2">
          Buscar
          <Input className="h-9 xl:h-8" value={filters.text} onChange={(event) => search(event.target.value)} placeholder="OAI, OA o PR, resumen o quien reportó" />
        </label>
        <FilterSelect label="Estado" field="status" value={filters.status} options={options.status} onChange={set("status")} />
        <FilterSelect label="App" field="app" value={filters.app} options={options.app} onChange={set("app")} />
        <FilterSelect label="Dificultad" field="difficulty" value={filters.difficulty} options={options.difficulty} onChange={set("difficulty")} />
        <FilterSelect label="Asignado a" field="assignee" value={filters.assignee} options={options.assignee} onChange={set("assignee")} />
        <Button variant="ghost" size="sm" className="col-span-2 justify-self-end xl:col-span-1 xl:h-8" onClick={() => setFilters(NO_FILTERS)}>
          Limpiar filtros
        </Button>
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as IntakeTab)} className="min-h-0 flex-1 overflow-hidden">
        <TabsList className="shrink-0">
          {TICKET_TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.title} ({ticketsOf(entry.id, filtered).length})
            </TabsTrigger>
          ))}
        </TabsList>
        {TICKET_TABS.map((entry) => (
          <TabsContent key={entry.id} value={entry.id} className="flex min-h-0 flex-col gap-2 overflow-hidden">
            {entry.id === "recientes" && view.canvasRowCap !== null && (
              <p className="text-xs text-muted-foreground">
                Los mismos tickets que muestra el canvas del canal, que tiene un máximo de {view.canvasRowCap} filas por sección.
              </p>
            )}
            <DataTable columns={TICKET_COLUMNS} data={ticketsOf(entry.id, filtered)} empty={entry.empty} resetKey={JSON.stringify(filters)} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/* --------------------------------------------------------------- metrics */

const reportColumns = (first: string, firstOf: (row: IntakeMetricsRow) => string): ColumnDef<IntakeMetricsRow>[] => [
  { id: "key", accessorFn: firstOf, header: first },
  { accessorKey: "reports", header: "Reportes" },
  { accessorKey: "valuable", header: "Valiosos" },
  { accessorKey: "noise", header: "Ruido" },
  { accessorKey: "pending", header: "Pendientes" },
  { accessorKey: "duplicates", header: "Ya reportados" },
  { id: "valuableRate", accessorFn: (row) => (row.reports === 0 ? -1 : row.valuable / row.reports), header: "% valiosos", cell: ({ row }) => valuableRate(row.original) },
  { accessorKey: "noiseRate", header: "% ruido", cell: ({ row }) => percent(row.original.noiseRate) },
  { accessorKey: "confirmed", header: "Confirmados" },
  { accessorKey: "medianConfirmLatencyMs", header: "Latencia de confirmación (mediana)", cell: ({ row }) => duration(row.original.medianConfirmLatencyMs) },
  { accessorKey: "overrideRate", header: "% corregidos", cell: ({ row }) => percent(row.original.overrideRate) },
  {
    id: "overrides",
    header: "Correcciones por campo",
    enableSorting: false,
    cell: ({ row }) => {
      const fields = overridesOf(row.original);
      return fields.length === 0 ? "-" : (
        <ul className="text-xs">
          {fields.map((field) => (
            <li key={field.field}>
              {field.field}: {field.count} ({field.rate})
            </li>
          ))}
        </ul>
      );
    },
  },
  {
    id: "changes",
    header: "Cambios más comunes (agente a persona)",
    enableSorting: false,
    cell: ({ row }) => {
      const changes = changesOf(row.original);
      return changes.length === 0 ? "-" : (
        <ul className="min-w-56 text-xs">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      );
    },
  },
];

const PARTICIPATION_COLUMNS: ColumnDef<IntakeParticipationRow>[] = [
  { id: "key", accessorFn: reporterLabel, header: "Reportero" },
  { accessorKey: "reports", header: "Reportes" },
  { accessorKey: "last7Days", header: "Últimos 7 días" },
  { accessorKey: "last30Days", header: "Últimos 30 días" },
  { accessorKey: "activeWeeks", header: "Semanas activas" },
  {
    accessorKey: "lastReportAt",
    header: `Último reporte (${CHILE_TIME_LABEL})`,
    cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{chileDateTime(row.original.lastReportAt)}</span>,
  },
];

const PRECISION_FIELD_COLUMNS: ColumnDef<IntakePrecisionFieldRow>[] = [
  { id: "field", accessorFn: (row) => fieldLabel(row.field), header: "Campo" },
  { accessorKey: "confirmed", header: "Confirmados" },
  { accessorKey: "corrected", header: "Corregidos" },
  { id: "precision", accessorFn: (row) => row.precision ?? -1, header: "% sin cambios", cell: ({ row }) => percent(row.original.precision) },
  {
    id: "changes",
    header: "Cambios más comunes (agente a persona)",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.topChanges.length === 0 ? (
        "-"
      ) : (
        <ul className="min-w-56 text-xs">
          {row.original.topChanges.map((change) => (
            <li key={`${change.agent}>${change.human}`}>
              {overrideValue(row.original.field, change.agent)} a {overrideValue(row.original.field, change.human)} ({change.count})
            </li>
          ))}
        </ul>
      ),
  },
];

const PRECISION_WEEK_COLUMNS: ColumnDef<IntakePrecisionWeekRow>[] = [
  { accessorKey: "week", header: "Semana" },
  { accessorKey: "confirmed", header: "Confirmados" },
  { accessorKey: "exact", header: "Sin cambios" },
  { id: "precision", accessorFn: (row) => row.precision ?? -1, header: "% sin cambios", cell: ({ row }) => percent(row.original.precision) },
  {
    id: "fields",
    header: "Campos corregidos",
    enableSorting: false,
    cell: ({ row }) => {
      const fields = Object.entries(row.original.correctedByField).sort((a, b) => b[1] - a[1]);
      return fields.length === 0 ? "-" : fields.map(([field, count]) => `${fieldLabel(field)}: ${count}`).join(", ");
    },
  },
];

const PRECISION_CORRECTION_COLUMNS: ColumnDef<IntakePrecisionCorrection>[] = [
  { accessorKey: "key", header: "Ticket" },
  { id: "field", accessorFn: (row) => fieldLabel(row.field), header: "Campo" },
  { id: "agent", accessorFn: (row) => overrideValue(row.field, row.agent), header: "Agente", cell: ({ getValue }) => <span className="block max-w-80 text-xs">{getValue() as string}</span> },
  { id: "human", accessorFn: (row) => overrideValue(row.field, row.human), header: "Persona", cell: ({ getValue }) => <span className="block max-w-80 text-xs">{getValue() as string}</span> },
  { id: "by", accessorFn: (row) => row.by ?? "-", header: "Quién" },
  {
    accessorKey: "at",
    header: `Cuándo (${CHILE_TIME_LABEL})`,
    cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{chileDateTime(row.original.at)}</span>,
  },
];

/** How often confirmers correct the clerk: the share of fields and tickets left as proposed, and each correction. */
function PrecisionTables({ view }: { view: IntakePrecisionView }) {
  return (
    <Tabs defaultValue="field" className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <p className="text-xs text-muted-foreground">
        {view.confirmed === 0
          ? "Todavía no hay tickets confirmados con una propuesta del agente para comparar."
          : `${view.exact} de ${view.confirmed} tickets confirmados quedaron tal como los propuso el agente (${percent(view.precision)}). Cada cambio de una persona al confirmar cuenta como una corrección.`}
      </p>
      <TabsList className="max-w-full shrink-0 overflow-x-auto">
        <TabsTrigger value="field">Por campo</TabsTrigger>
        <TabsTrigger value="week">Por semana</TabsTrigger>
        <TabsTrigger value="corrections">Correcciones ({view.corrections.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="field" className="flex min-h-0 overflow-hidden">
        <DataTable columns={PRECISION_FIELD_COLUMNS} data={view.byField} empty="Sin tickets confirmados." />
      </TabsContent>
      <TabsContent value="week" className="flex min-h-0 overflow-hidden">
        <DataTable columns={PRECISION_WEEK_COLUMNS} data={view.byWeek} empty="Sin tickets confirmados." />
      </TabsContent>
      <TabsContent value="corrections" className="flex min-h-0 overflow-hidden">
        <DataTable columns={PRECISION_CORRECTION_COLUMNS} data={view.corrections} empty="Nadie ha corregido al agente todavía." />
      </TabsContent>
    </Tabs>
  );
}

function MetricsTables({ view }: { view: IntakeMetricsView }) {
  if (!view.available) {
    return (
      <Alert>
        <AlertTitle>Sin métricas</AlertTitle>
        <AlertDescription>{view.reason ?? "El clerk todavía no ha registrado reportes."}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Tabs defaultValue="reporter" className="min-h-0 flex-1 overflow-hidden">
      <p className="text-xs text-muted-foreground">
        Métricas calculadas: {chileDateTime(view.generatedAt)} ({CHILE_TIME_LABEL})
      </p>
      <TabsList className="max-w-full shrink-0 overflow-x-auto">
        <TabsTrigger value="reporter">Por reportero</TabsTrigger>
        <TabsTrigger value="app">Por app</TabsTrigger>
        <TabsTrigger value="week">Por semana</TabsTrigger>
        <TabsTrigger value="participation">Participación</TabsTrigger>
        <TabsTrigger value="precision">Precisión</TabsTrigger>
      </TabsList>
      <TabsContent value="reporter" className="flex min-h-0 overflow-hidden">
        <DataTable columns={reportColumns("Reportero", reporterLabel)} data={view.byReporter} empty="Sin reportes registrados." />
      </TabsContent>
      <TabsContent value="app" className="flex min-h-0 overflow-hidden">
        <DataTable columns={reportColumns("App", (row) => row.key)} data={view.byApp} empty="Sin reportes registrados." />
      </TabsContent>
      <TabsContent value="week" className="flex min-h-0 overflow-hidden">
        <DataTable columns={reportColumns("Semana", (row) => row.key)} data={view.byWeek} empty="Sin reportes registrados." />
      </TabsContent>
      <TabsContent value="participation" className="flex min-h-0 overflow-hidden">
        <DataTable columns={PARTICIPATION_COLUMNS} data={view.participation} empty="Nadie ha reportado todavía." />
      </TabsContent>
      <TabsContent value="precision" className="flex min-h-0 flex-col overflow-hidden">
        <PrecisionTables view={view.precision} />
      </TabsContent>
      {testReports(view) !== null && <p className="text-xs text-muted-foreground">{testReports(view)}</p>}
      {view.skippedLines > 0 && (
        <p className="text-xs text-muted-foreground">Se omitieron {view.skippedLines} líneas ilegibles del registro.</p>
      )}
    </Tabs>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CommandError | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    // An open route: sendCommand sends same-origin credentials, so the session cookie it sets sticks.
    const answer = await send("/api/intake/login", { password });
    setBusy(false);
    if (!answer.ok) {
      setProblem(answer.error);
      return;
    }
    setPassword("");
    onDone();
  };
  return (
    <Card className="max-h-full min-h-0 w-full max-w-md overflow-y-auto">
      <CardHeader>
        <CardTitle>Métricas protegidas</CardTitle>
        <CardDescription>Ingresa la contraseña de las métricas para verlas.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Contraseña" />
          {problem !== null && (
            <div className="text-sm text-destructive">
              <CommandNotice error={problem} />
            </div>
          )}
          <Button type="submit" disabled={busy || password === ""}>
            {busy ? "Verificando..." : "Entrar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Metrics({ project }: { project: string }) {
  const sessionRead = useIntakeSession(project);
  const session = sessionRead.read;
  const access = shown(session)?.access ?? null;
  const open = access === "local" || access === "unlocked";
  // Asked only once the server says this browser may read it.
  const metricsRead = useIntakeMetrics(project, open);
  const metrics = metricsRead.read;
  // A refused metrics read means access is gone: the gated numbers must not
  // stay up as merely stale, the way an open read's data does.
  const refused = metrics.state === "error" && (metrics.status === 401 || metrics.status === 403);
  const metricsView = refused ? null : shown(metrics);
  // After a login or a logout the session's answer changes: read it again now.
  // Only the session: metrics are read only while it is open, so a login
  // subscribes them fresh, and re-reading them on a logout would race the
  // session to a 401 and flash a refresh failure over numbers about to go.
  const again = sessionRead.refresh;

  if (session.state === "loading") return <Skeleton className="h-32 w-full" />;
  if (session.state === "error" && session.data === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>No se pudo consultar el acceso</AlertTitle>
        <AlertDescription>{session.message}</AlertDescription>
      </Alert>
    );
  }
  if (access === "unconfigured") {
    return (
      <Alert>
        <AlertTitle>Métricas bloqueadas</AlertTitle>
        <AlertDescription>Este despliegue no tiene contraseña de métricas configurada, así que nadie puede verlas.</AlertDescription>
      </Alert>
    );
  }
  if (access === "locked") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <Login onDone={again} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {access === "unlocked" && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              // A failed logout is not shown: the session re-read says whether it is still open.
              await send("/api/intake/logout");
              again();
            }}
          >
            Cerrar sesión
          </Button>
        </div>
      )}
      <Stale read={session} />
      {!refused && <Stale read={metrics} />}
      {metricsView !== null ? (
        <MetricsTables view={metricsView} />
      ) : metrics.state === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudieron cargar las métricas</AlertTitle>
          <AlertDescription>{metrics.message}</AlertDescription>
        </Alert>
      ) : (
        <Skeleton className="h-32 w-full" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

type IntakeSection = "tickets" | "metrics";

/**
 * The sidebar's shortcuts, grouped. They come with the snapshot, from the
 * clerk's config, so the page names no team's repos or boards itself.
 */
const RESOURCE_ICONS = { GitHub: GitBranch, Jira: Kanban } as const;

function resourceGroups(links: readonly IntakeLinkView[]) {
  return (["GitHub", "Jira"] as const)
    .map((label) => ({ label, icon: RESOURCE_ICONS[label], links: links.filter((link) => link.group === label) }))
    .filter((group) => group.links.length > 0);
}

function IntakeSidebar({
  section,
  onNavigate,
  title,
  links,
}: {
  section: IntakeSection;
  onNavigate: (section: IntakeSection) => void;
  title: string | null;
  links: readonly IntakeLinkView[];
}) {
  const { setOpenMobile } = useSidebar();
  const navigate = (next: IntakeSection) => {
    onNavigate(next);
    setOpenMobile(false);
  };
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b px-3">
        <div className="flex items-center gap-2 font-semibold">
          <Inbox className="size-5 shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">{title ?? "Intake"}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Reportes del canal</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Navegación principal">
              <SidebarMenu>
                {([
                  { id: "tickets", label: "Tickets", icon: Inbox },
                  { id: "metrics", label: "Métricas", icon: BarChart3 },
                ] as const).map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={section === item.id}
                      aria-current={section === item.id ? "page" : undefined}
                      tooltip={item.label}
                      onClick={() => navigate(item.id)}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        {resourceGroups(links).map((group, index) => (
          <SidebarGroup key={group.label} className={index === 0 ? "mt-auto" : undefined}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <nav aria-label={`Enlaces de ${group.label}`}>
                <SidebarMenu>
                  {group.links.map((link) => (
                    <SidebarMenuItem key={link.url}>
                      <SidebarMenuButton asChild tooltip={`${group.label} · ${link.label}`}>
                        <a href={link.url} {...external}>
                          <group.icon aria-hidden="true" />
                          <span className="flex-1 truncate">{link.label}</span>
                          <ArrowUpRight aria-hidden="true" className="ml-auto text-muted-foreground group-data-[collapsible=icon]:hidden" />
                          <span className="sr-only">(abre en una pestaña nueva)</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t p-4 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        Actualización automática cada minuto
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Any page but the intake page on the open intake deployment: the team gets
 * there by trimming the link, and it serves nothing else to show.
 */
export function IntakeNotFound({ project }: { project: string | null }) {
  useEffect(() => {
    document.title = "Página no encontrada";
  }, []);
  return (
    <main className="flex h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Página no encontrada</CardTitle>
          <CardDescription>Esta dirección no existe. Aquí solo está el intake de reportes del canal.</CardDescription>
        </CardHeader>
        {project !== null && (
          <CardContent>
            <Button asChild>
              <a href={pagePath(project, "/intake")}>Ir al intake de reportes</a>
            </Button>
          </CardContent>
        )}
      </Card>
    </main>
  );
}

export function IntakePage({ project }: { project: string }) {
  const tickets = useIntake(project).read;
  const view = shown(tickets);
  const [section, setSection] = useState<IntakeSection>("tickets");
  useEffect(() => {
    document.title = "Intake de reportes";
  }, []);
  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <IntakeSidebar section={section} onNavigate={setSection} title={view?.title ?? null} links={view?.links ?? []} />
      <SidebarInset className="h-dvh overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <SidebarTrigger aria-label="Mostrar u ocultar menú" />
          <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
          <nav aria-label="Ubicación" className="flex min-w-0 items-center gap-2 text-sm">
            {view?.title && (
              <>
                <span className="hidden text-muted-foreground sm:inline">{view.title}</span>
                <span aria-hidden="true" className="hidden text-muted-foreground sm:inline">/</span>
              </>
            )}
            <h1 className="truncate font-medium">Intake de reportes</h1>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <Badge variant="outline" className="hidden sm:inline-flex">{section === "tickets" ? "Tickets" : "Métricas"}</Badge>
            <IntakeThemeSelector />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-4 py-3 md:px-6">
          <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <h2 className="text-base font-medium">{section === "tickets" ? "Tickets" : "Métricas"}</h2>
            {view !== null && view.generatedAt !== null && (
              <p className="text-xs text-muted-foreground">
                Actualizado: {chileDateTime(view.generatedAt)} ({CHILE_TIME_LABEL}){modeNotice(view.mode)}
              </p>
            )}
          </div>
          <div className={section === "tickets" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}>
            <Stale read={tickets} />
            {view === null ? (
              tickets.state === "error" ? (
                <Alert variant="destructive">
                  <AlertTitle>No se pudieron cargar los tickets</AlertTitle>
                  <AlertDescription>{tickets.message}</AlertDescription>
                </Alert>
              ) : (
                <Skeleton className="h-48 w-full" />
              )
            ) : !view.available ? (
              <Alert>
                <AlertTitle>Sin tickets</AlertTitle>
                <AlertDescription>{view.reason ?? "Todavía no hay tickets."}</AlertDescription>
              </Alert>
            ) : (
              <Tickets view={view} />
            )}
          </div>
          {section === "metrics" && <Metrics project={project} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
