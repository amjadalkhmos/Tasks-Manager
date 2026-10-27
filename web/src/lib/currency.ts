import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** The currency of a project's deals (every project has one; it only shows where a task has a value). */
export function useCurrencyOf() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  return (projectId: number | null) => projects.data?.find((p) => p.id === projectId)?.currency ?? "USD";
}
