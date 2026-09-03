import type { ProjectManagerModalProps } from "./project-manager/types";
import ProjectManagerContent from "./ProjectManagerContent";

export default function ProjectManagerModal({ agents, departments = [], onClose }: ProjectManagerModalProps) {
  return <ProjectManagerContent agents={agents} departments={departments} onClose={onClose} />;
}
