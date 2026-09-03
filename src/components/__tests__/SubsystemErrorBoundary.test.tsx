import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SubsystemErrorBoundary } from "../SubsystemErrorBoundary";

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("boom");
  return <div>child content</div>;
}

describe("SubsystemErrorBoundary", () => {
  // Suppress console.error from componentDidCatch during tests
  const originalConsoleError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("renders children when no error", () => {
    render(
      <SubsystemErrorBoundary name="Test">
        <div>hello</div>
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("hello")).toBeVisible();
  });

  it("shows error UI when child throws", () => {
    render(
      <SubsystemErrorBoundary name="Test Widget">
        <ThrowingChild shouldThrow />
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("Test Widget crashed")).toBeVisible();
    expect(screen.getByText("boom")).toBeVisible();
    expect(screen.getByText("Retry")).toBeVisible();
  });

  it("recovers on Retry click", () => {
    const { rerender } = render(
      <SubsystemErrorBoundary name="Test">
        <ThrowingChild shouldThrow />
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("Test crashed")).toBeVisible();

    // Re-render with non-throwing child before clicking retry
    rerender(
      <SubsystemErrorBoundary name="Test">
        <ThrowingChild shouldThrow={false} />
      </SubsystemErrorBoundary>,
    );
    fireEvent.click(screen.getByText("Retry"));
    expect(screen.getByText("child content")).toBeVisible();
  });

  it("auto-resets when resetKey changes", () => {
    const { rerender } = render(
      <SubsystemErrorBoundary name="Graph" resetKey="pack-a">
        <ThrowingChild shouldThrow />
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("Graph crashed")).toBeVisible();

    // Change resetKey and provide a non-throwing child
    rerender(
      <SubsystemErrorBoundary name="Graph" resetKey="pack-b">
        <ThrowingChild shouldThrow={false} />
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("child content")).toBeVisible();
  });

  it("stays in error state when resetKey does NOT change", () => {
    const { rerender } = render(
      <SubsystemErrorBoundary name="Graph" resetKey="pack-a">
        <ThrowingChild shouldThrow />
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("Graph crashed")).toBeVisible();

    // Re-render with same key but non-throwing child — should stay in error
    rerender(
      <SubsystemErrorBoundary name="Graph" resetKey="pack-a">
        <ThrowingChild shouldThrow={false} />
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("Graph crashed")).toBeVisible();
  });

  it("uses custom fallback when provided", () => {
    render(
      <SubsystemErrorBoundary
        name="Custom"
        fallback={(error, reset) => (
          <div>
            <span>custom: {error.message}</span>
            <button onClick={reset}>fix it</button>
          </div>
        )}
      >
        <ThrowingChild shouldThrow />
      </SubsystemErrorBoundary>,
    );
    expect(screen.getByText("custom: boom")).toBeVisible();
    expect(screen.getByText("fix it")).toBeVisible();
  });
});
