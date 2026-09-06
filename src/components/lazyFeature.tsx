import { lazy, Suspense, type ComponentType } from "react";
import { useI18n } from "../i18n";
import { SubsystemErrorBoundary } from "./SubsystemErrorBoundary";

/** Keep optional features out of the initial download and isolate loading failures. */
export function lazyFeature<Props extends object>(load: () => Promise<{ default: ComponentType<Props> }>) {
  const Feature = lazy(load);
  return function LazyFeature(props: Props) {
    const { language } = useI18n();
    const german = language === "de";
    return (
      <SubsystemErrorBoundary
        name="Feature"
        fallback={() => (
          <div role="alert" className="p-4 text-sm text-[var(--text-secondary)]">
            <p>{german ? "Der Bereich konnte nicht geladen werden." : "This section could not be loaded."}</p>
            <button type="button" className="mt-2 underline" onClick={() => window.location.reload()}>
              {german ? "Seite neu laden" : "Reload page"}
            </button>
          </div>
        )}
      >
        <Suspense
          fallback={
            <div role="status" className="min-h-24 p-4 text-sm text-[var(--text-secondary)]">
              {german ? "Wird geladen …" : "Loading …"}
            </div>
          }
        >
          <Feature {...props} />
        </Suspense>
      </SubsystemErrorBoundary>
    );
  };
}
