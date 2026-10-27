import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { clearApiCaches, setCurrentUser } from "./lib/offline";
import { LoginPage } from "./pages/LoginPage";
import { PublicLeadPage } from "./pages/PublicLeadPage";
import { PublicSupportPage } from "./pages/PublicSupportPage";
import { Shell } from "./pages/Shell";

export function App() {
  const { pathname } = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const signedOut = !me.isLoading && !me.data;

  // Nobody is signed in, so nothing cached for offline use may remain. This also covers responses that were still
  // in flight when someone signed out and landed in the cache just after it was emptied.
  useEffect(() => {
    if (signedOut) void clearApiCaches();
  }, [signedOut]);

  // A customer's support form: public, with no sign-in and none of the app around it.
  if (pathname.startsWith("/support/")) {
    return (
      <Routes>
        <Route path="/support/:token" element={<PublicSupportPage />} />
      </Routes>
    );
  }

  // A prospect's contact form: the same, public and bare.
  if (pathname.startsWith("/inquiry/")) {
    return (
      <Routes>
        <Route path="/inquiry/:token" element={<PublicLeadPage />} />
      </Routes>
    );
  }

  if (me.isLoading) return <p className="center" role="status">Loading…</p>;
  const user = me.data;
  setCurrentUser(user?.id ?? null);

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/*" element={user ? <Shell user={user} /> : <Navigate to="/login" replace />} />
    </Routes>
  );
}
