import { useId, type ReactNode } from "react";
import { useDialog } from "../../hooks/useDialog";

interface MobileBottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  maxHeight?: string;
}

export function MobileBottomSheet({ open, onClose, children, title, maxHeight = "85dvh" }: MobileBottomSheetProps) {
  const titleId = useId();
  const { dialogRef } = useDialog<HTMLDivElement>({ isOpen: open, onClose });

  if (!open) return null;

  const ariaProps = title ? { "aria-labelledby": titleId } : { "aria-label": "Dialog" };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div
        data-testid="bottom-sheet-backdrop"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        {...ariaProps}
        data-testid="bottom-sheet-panel"
        className="relative flex flex-col overflow-hidden rounded-t-2xl outline-none"
        style={{
          maxHeight,
          background: "var(--th-bg-primary)",
          borderTop: "1px solid var(--th-border)",
        }}
      >
        <div className="flex flex-col items-center px-4 pt-3 pb-2">
          <div
            data-testid="drag-handle"
            className="h-1 w-10 rounded-full"
            style={{ background: "var(--th-text-secondary)", opacity: 0.4 }}
          />
          {title && (
            <h3
              id={titleId}
              className="mt-2"
              style={{
                color: "var(--th-text-primary)",
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              {title}
            </h3>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-[env(safe-area-inset-bottom)]">{children}</div>
      </div>
    </div>
  );
}
