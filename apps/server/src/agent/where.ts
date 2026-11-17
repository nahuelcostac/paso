import { isLooseProject } from '@paso/shared';

/** Where a run works, said in the agent's instructions with the service IDs. It follows “You are working in the …”. */
export function describeTarget({ projectId, sceneId }: { projectId: string; sceneId?: string }) {
  // A loose diagram is one scene of a reserved project that lists of projects never show.
  if (isLooseProject(projectId) && sceneId) {
    return `loose diagram: reserved project "${projectId}", scene "${sceneId}". Work only in that scene and do not create new scenes`;
  }
  return `project "${projectId}"` + (sceneId ? `, scene "${sceneId}"` : '');
}
