import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { clearApiCaches, setCurrentUser } from "./lib/offline";
import { LoginPage } from "./pages/LoginPage";
import { Shell } from "./pages/Shell";

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const signedOut = !me.isLoading && !me.data;

  // Nobody is signed in, so nothing cached for offline use may remain. This also covers responses that were still
  // in flight when someone signed out and landed in the cache just after it was emptied.
  useEffect(() => {
    if (signedOut) void clearApiCaches();
  }, [signedOut]);

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
