import type { Agent, Department } from "../types";
import { useMobile } from "../hooks/useMobile";
import ProjectManagerContent from "./ProjectManagerContent";
import { MobileProjectsView } from "./mobile/MobileProjectsView";

interface ProjectsViewProps {
  agents: Agent[];
  departments: Department[];
}

export default function ProjectsView({ agents, departments }: ProjectsViewProps) {
  const { isMobile } = useMobile();
  if (isMobile) return <MobileProjectsView agents={agents} departments={departments} />;
  return <ProjectManagerContent agents={agents} departments={departments} embedded />;
}
