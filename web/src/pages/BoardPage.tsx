import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Board } from "../components/Board";

export function BoardPage({ onOpen }: { onOpen: (id: number) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [project, setProject] = useState("");
  const picked = projects.data?.find((p) => p.id === Number(project));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Board</h1>
          <p className="sub">
            Drag cards between columns, or use the arrows.
            {!picked && " Choose a project to see its own statuses as columns."}
          </p>
        </div>
        <div className="page-actions">
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project">
            <option value="">All projects</option>
            {projects.data?.filter((p) => p.stage !== "archived" || String(p.id) === project).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </header>
      <Board project={picked} onOpen={onOpen} />
    </div>
  );
}
