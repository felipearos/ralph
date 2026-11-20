/**
 * A titled band of a long form: its heading and one-line blurb on a left
 * rail, stacked above the fields on a narrow screen, a rule between bands.
 * It is a labelled group, so a screen reader announces the heading the way
 * it would a fieldset's legend.
 */
import type { LucideIcon } from "lucide-react";
import { useId } from "react";

export function FormSection({
  title,
  blurb,
  icon: Icon,
  children,
}: {
  title: string;
  blurb: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  const heading = useId();
  return (
    <section
      role="group"
      aria-labelledby={heading}
      className="grid gap-4 border-t pt-5 first:border-t-0 first:pt-0 md:grid-cols-[11rem_1fr] md:gap-6"
    >
      <div>
        <h3 id={heading} className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          {title}
        </h3>
        <p className="mt-1 pl-5.5 text-xs leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
      {children}
    </section>
  );
}
