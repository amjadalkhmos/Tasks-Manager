import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** Names for everyone the signed-in person shares a workspace with (and themselves). */
export function usePeople() {
  const q = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 60_000 });
  const people = q.data ?? [];
  const byId = new Map(people.map((p) => [p.id, p]));
  return {
    people,
    byId,
    /** Someone who has since left the workspace is no longer listed, but their history remains. */
    nameOf: (id: number | null | undefined) => (id == null ? "" : (byId.get(id)?.name ?? "A former member")),
  };
}
