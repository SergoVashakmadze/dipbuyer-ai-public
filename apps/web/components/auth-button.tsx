"use client";

import { useAuth0 } from "@auth0/auth0-react";

/**
 * Login/profile/logout control. useAuth0 is always called (rules of hooks); it returns a safe
 * default context when no provider is mounted, so we simply hide the control until Auth0 is
 * configured via NEXT_PUBLIC_AUTH0_DOMAIN.
 */
export function AuthButton() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0();
  const configured = !!process.env.NEXT_PUBLIC_AUTH0_DOMAIN;
  if (!configured) return null;
  if (isLoading) return <span className="muted">…</span>;

  if (isAuthenticated) {
    return (
      <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
        <span className="muted small auth-name">{user?.name ?? user?.email}</span>
        <button className="btn btn-outline btn-sm" onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
          Log out
        </button>
      </span>
    );
  }
  return (
    <button className="btn btn-sm" onClick={() => loginWithRedirect()}>
      Sign in
    </button>
  );
}
