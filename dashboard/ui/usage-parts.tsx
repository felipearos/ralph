/**
 * Small pieces the Usage page's sections share: the provider logo, the
 * figure tile, and the segmented switch every range and scope picker on the
 * page is drawn with.
 */
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { providerBrand } from "./usagebar-brand";

/** A provider's colour, or the muted foreground for one with no brand colour. */
export const providerColor = (provider: string): string => providerBrand(provider).color ?? "var(--muted-foreground)";

/** A provider's logo in its brand colour; a dot of that colour when there is no logo. */
export function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  const brand = providerBrand(provider);
  const color = providerColor(provider);
  if (brand.logo === null) {
    return (
      <span aria-hidden className={cn("inline-grid size-4 shrink-0 place-items-center", className)}>
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
      </span>
    );
  }
  const mask = `url("${brand.logo}") center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-4 shrink-0", className)}
      style={{ backgroundColor: color, mask, WebkitMask: mask }}
    />
  );
}

const ITEM =
  "h-auto px-2.5 py-1 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground";

/** One choice of several, as the page's other toggles are drawn. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      className="inline-flex border p-0.5"
      aria-label={label}
      value={value}
      // Radix reports "" when the active item is clicked again: the choice stays.
      onValueChange={(next) => {
        const option = options.find((entry) => entry.value === next);
        if (option !== undefined) onChange(option.value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className={ITEM} {...(option.title === undefined ? {} : { title: option.title })}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** One figure with its label, and a hint under it when there is one. */
export function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
