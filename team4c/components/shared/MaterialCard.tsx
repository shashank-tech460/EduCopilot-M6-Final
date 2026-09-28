import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge, type MaterialStatus } from "@/components/shared/StatusBadge";
import { cn } from "@/lib/utils";
import type { MaterialSummary } from "@/components/shared/workspace-files";

type IconComponent = React.ComponentType<{ className?: string }>;

interface MaterialCardProps {
  material: MaterialSummary;
  icon: IconComponent;
  typeLabel: string;
  sizeLabel: string | null;
  dateLabel: string;
  onSelect: (material: MaterialSummary) => void;
  onDelete: (material: MaterialSummary) => void;
  isDeleting: boolean;
  /** Stage 9 — retries Team A ingestion for a `status === "failed"`
   * material without re-uploading any bytes. */
  onRetryIngestion: (material: MaterialSummary) => void;
  isRetrying: boolean;
}

/**
 * Phase 6E — first-class material card, replacing the flat text-row list
 * previously in workspace-files.tsx (audit section 9). Preserves every
 * existing accessible name/text contract the real component/E2E tests
 * depend on: aria-label "Play {name}"/"Open {name}" on the clickable
 * element, plain text nodes for filename/type/status/size/date, and the
 * "Delete" button text — restructured visually, not behaviorally.
 */
export function MaterialCard({
  material,
  icon: Icon,
  typeLabel,
  sizeLabel,
  dateLabel,
  onSelect,
  onDelete,
  isDeleting,
  onRetryIngestion,
  isRetrying,
}: MaterialCardProps) {
  const isReady = material.status === "ready";
  const isFailed = material.status === "failed";

  return (
    <div
      className={cn(
        "group flex items-start justify-between gap-3 rounded-lg border bg-card p-3.5 transition-[box-shadow,border-color] duration-[var(--duration-md)]",
        isReady && "hover:border-primary/35 hover:shadow-[var(--shadow-md)]"
      )}
    >
      {isReady ? (
        <button
          type="button"
          onClick={() => onSelect(material)}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={material.type === "pdf" ? `Open ${material.originalName}` : `Play ${material.originalName}`}
        >
          <MaterialIcon icon={Icon} status={material.status} />
          <MaterialMeta
            material={material}
            typeLabel={typeLabel}
            sizeLabel={sizeLabel}
            dateLabel={dateLabel}
          />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <MaterialIcon icon={Icon} status={material.status} />
          <MaterialMeta
            material={material}
            typeLabel={typeLabel}
            sizeLabel={sizeLabel}
            dateLabel={dateLabel}
          />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {isFailed ? (
          <Button
            variant="outline"
            size="sm"
            className="opacity-70 transition-opacity group-hover:opacity-100"
            onClick={() => onRetryIngestion(material)}
            disabled={isRetrying}
          >
            {isRetrying ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="opacity-70 transition-opacity group-hover:opacity-100"
          onClick={() => onDelete(material)}
          disabled={isDeleting}
        >
          <Trash2 className="h-4 w-4" />
          {isDeleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </div>
  );
}

function MaterialIcon({ icon: Icon, status }: { icon: IconComponent; status: MaterialStatus }) {
  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-transform duration-[var(--duration-md)] group-hover:scale-105",
        status === "ready"
          ? "bg-gradient-to-br from-brand-indigo/25 to-brand-violet/15 text-brand-indigo"
          : "bg-muted text-muted-foreground"
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </div>
  );
}

function MaterialMeta({
  material,
  typeLabel,
  sizeLabel,
  dateLabel,
}: {
  material: MaterialSummary;
  typeLabel: string;
  sizeLabel: string | null;
  dateLabel: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium" title={material.originalName}>
        {material.originalName}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge status={material.status} />
        <span className="text-xs text-muted-foreground">{typeLabel}</span>
        {sizeLabel ? <span className="text-xs text-muted-foreground">{sizeLabel}</span> : null}
        <span className="text-xs text-muted-foreground">{dateLabel}</span>
      </div>
      {material.status === "failed" && material.processingError ? (
        <p className="mt-1 text-xs text-destructive">{material.processingError}</p>
      ) : null}
    </div>
  );
}
