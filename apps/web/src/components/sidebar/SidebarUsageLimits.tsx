import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { environmentPresentations } from "../../state/presentation";
import { barColor } from "../usage/UsageLimits";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Claude and Codex weekly. Pooled across accounts and environments like the Usage page.
const SHOWN = [
  { driver: "claudeAgent", label: "Claude", windows: ["seven_day"] },
  { driver: "codex", label: "Codex", windows: ["weekly"] },
] as const;

const SHORT_LABEL: Record<string, string> = { seven_day: "wk", weekly: "wk" };

/** Compact remaining-quota readout for the sidebar footer; opens the Usage page. */
export const SidebarUsageLimits = memo(function SidebarUsageLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // Only remainingPercent is read, which does not depend on the clock (pace and reset times do).
  const pools = collectLimitPools(collectLimitAccounts(presentations), 0);
  const rows = SHOWN.flatMap((shown) => {
    const pool = pools.find((candidate) => candidate.driver === shown.driver);
    const windows = shown.windows.flatMap((id) => {
      const window = pool?.windows.find((candidate) => candidate.id === id);
      return window ? [{ id, label: window.label, remaining: window.remainingPercent }] : [];
    });
    return pool && windows.length > 0 ? [{ ...shown, color: barColor(pool.driver), windows }] : [];
  });
  if (rows.length === 0) return null;

  const title = rows
    .flatMap((row) => row.windows.map((w) => `${row.label} ${w.label}: ${w.remaining}% left`))
    .join("\n");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Usage limits. ${title}`}
            className="flex w-full items-center gap-3 rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              void navigate({ to: "/usage" });
            }}
          />
        }
      >
        {rows.map((row) => (
          <span key={row.driver} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            <span className="text-foreground">{row.label}</span>
            {row.windows.map((w) => (
              <span key={w.id}>
                {SHORT_LABEL[w.id]} {w.remaining}%
              </span>
            ))}
          </span>
        ))}
      </TooltipTrigger>
      <TooltipPopup side="top" className="whitespace-pre-line">
        {title}
      </TooltipPopup>
    </Tooltip>
  );
});
