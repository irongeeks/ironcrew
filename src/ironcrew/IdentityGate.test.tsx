/**
 * The gate decides what a person sees before they are anybody.
 *
 * The three states come from the server, and the one that matters most is the
 * middle one: an installation with no accounts must keep working, because
 * that is every existing installation on the day it updates.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdentityGate } from "./IdentityGate";
import type { AuthStatus, CrewUser } from "./types";

const OWNER: CrewUser = {
  id: "usr_1",
  email: "robert@example.com",
  displayName: "Robert",
  role: "owner",
  status: "active",
  lastLoginAt: null,
  createdAt: 0,
  updatedAt: 0,
};

function client(overrides: Partial<Record<string, unknown>> = {}, status: AuthStatus) {
  return {
    authStatus: vi.fn(async () => status),
    login: vi.fn(async () => ({ ok: true, user: OWNER })),
    logout: vi.fn(async () => ({ ok: true })),
    createUser: vi.fn(async () => ({ ok: true, user: OWNER })),
    ...overrides,
  } as never;
}

describe("IdentityGate", () => {
  it("renders the app untouched while no account exists", async () => {
    const gate = client({}, { bootstrap: true, authenticated: false, user: null });
    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    expect(await screen.findByText("Command Center")).toBeTruthy();
    // …and says why the audit log has no name yet.
    expect(screen.getByText(/noch keine Benutzerkonten/)).toBeTruthy();
  });

  it("asks for a login once accounts exist, and shows nothing else", async () => {
    const gate = client({}, { bootstrap: false, authenticated: false, user: null });
    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    await screen.findByLabelText(/Passwort/);
    expect(screen.queryByText("Command Center")).toBeNull();
  });

  it("signs in and then renders the app", async () => {
    let status: AuthStatus = { bootstrap: false, authenticated: false, user: null };
    const gate = client(
      {
        authStatus: vi.fn(async () => status),
        login: vi.fn(async () => {
          status = { bootstrap: false, authenticated: true, user: OWNER };
          return { ok: true, user: OWNER };
        }),
      },
      status,
    );

    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    await userEvent.type(await screen.findByLabelText(/E-Mail/), "robert@example.com");
    await userEvent.type(screen.getByLabelText(/Passwort/), "correct horse staple");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));

    expect(await screen.findByText("Command Center")).toBeTruthy();
    expect(screen.getByText(/Robert · Inhaber/)).toBeTruthy();
  });

  it("shows the failure the server gave, not a generic one", async () => {
    const gate = client(
      {
        login: vi.fn(async () => {
          throw new Error("E-Mail oder Passwort stimmt nicht.");
        }),
      },
      { bootstrap: false, authenticated: false, user: null },
    );

    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    await userEvent.type(await screen.findByLabelText(/E-Mail/), "robert@example.com");
    await userEvent.type(screen.getByLabelText(/Passwort/), "falsch");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));

    expect(await screen.findByText("E-Mail oder Passwort stimmt nicht.")).toBeTruthy();
  });

  it("signs the first owner straight in, so they are not locked out by their own account", async () => {
    let status: AuthStatus = { bootstrap: true, authenticated: false, user: null };
    const login = vi.fn(async () => {
      status = { bootstrap: false, authenticated: true, user: OWNER };
      return { ok: true, user: OWNER };
    });
    const gate = client({ authStatus: vi.fn(async () => status), login }, status);

    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    await userEvent.click(await screen.findByText("Ersten Inhaber anlegen"));
    await userEvent.type(screen.getByLabelText(/E-Mail/), "robert@example.com");
    await userEvent.type(screen.getByLabelText(/^Passwort/), "correct horse staple");
    await userEvent.click(screen.getByRole("button", { name: "Inhaber anlegen" }));

    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(await screen.findByText(/Robert · Inhaber/)).toBeTruthy();
  });

  it("never hides the app because the status call failed", async () => {
    const gate = client(
      {
        authStatus: vi.fn(async () => {
          throw new Error("Server weg");
        }),
      },
      { bootstrap: true, authenticated: false, user: null },
    );

    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    // A gate that cannot ask must not lock the operator out of their own
    // installation.
    expect(await screen.findByText("Command Center")).toBeTruthy();
  });
});

describe("the directory login, next to the password login", () => {
  const LOGIN: AuthStatus = { bootstrap: false, authenticated: false, user: null };

  it("shows no button when no directory is configured", async () => {
    // The rule this whole codebase keeps: a control that has nothing behind
    // it is worse than no control, because pressing it teaches the operator
    // the system is broken.
    const gate = client({}, { ...LOGIN, oidc: { configured: false } });
    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );
    await screen.findByLabelText(/Passwort/);
    expect(screen.queryByTestId("oidc-start")).toBeNull();
  });

  it("shows none either when the server does not mention a directory at all", async () => {
    // An older control plane. An absent field reads as "no second door",
    // which is the correct interpretation.
    const gate = client({}, LOGIN);
    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );
    await screen.findByLabelText(/Passwort/);
    expect(screen.queryByTestId("oidc-start")).toBeNull();
  });

  it("offers the directory beside the password form, and names which one", async () => {
    const gate = client({}, { ...LOGIN, oidc: { configured: true, issuer: "https://idp.example.com" } });
    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    const link = await screen.findByTestId("oidc-start");
    // A link, not a button that fetches: the flow is a top-level navigation
    // to somebody else's origin and back, which an XHR cannot do.
    expect(link.getAttribute("href")).toBe("/api/crew/auth/oidc/start");
    expect(screen.getByText(/idp\.example\.com/)).toBeTruthy();
    // The password form stays. The day the directory is down is the day
    // somebody has to sign in and fix it.
    expect(screen.getByLabelText(/Passwort/)).toBeTruthy();
  });

  it("explains a refusal the callback sent back, and clears it from the URL", async () => {
    window.history.replaceState({}, "", "/?oidc_error=subject_not_linked");
    const gate = client({}, { ...LOGIN, oidc: { configured: true } });
    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    const shown = await screen.findByTestId("oidc-error");
    // The one refusal an owner can actually act on says what to do about it.
    expect(shown.textContent).toMatch(/verknüpft/);
    // Gone from the address bar, so a refresh does not re-show it and the
    // code is not carried into a bookmark.
    expect(window.location.search).toBe("");
  });

  it("falls back to a plain sentence for a code it does not know", async () => {
    // Twenty refusal codes exist and the person at a login form can act on
    // three of them. An unknown one must never surface as a raw identifier.
    window.history.replaceState({}, "", "/?oidc_error=id_token_audience_mismatch");
    const gate = client({}, { ...LOGIN, oidc: { configured: true } });
    render(
      <IdentityGate client={gate}>
        <div>Command Center</div>
      </IdentityGate>,
    );

    const shown = await screen.findByTestId("oidc-error");
    expect(shown.textContent).toMatch(/fehlgeschlagen/);
    expect(shown.textContent).not.toContain("id_token_audience_mismatch");
  });
});
