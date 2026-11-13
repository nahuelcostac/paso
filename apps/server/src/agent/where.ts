import { isLooseProject } from '@paso/shared';

/** Where a run works, said in the agent's instructions with the service IDs. It follows «Trabajas en el …». */
export function describeTarget({ projectId, sceneId }: { projectId: string; sceneId?: string }) {
  // A loose diagram is one scene of a reserved project that lists of projects never show.
  if (isLooseProject(projectId) && sceneId) {
    return `diagrama suelto: proyecto reservado «${projectId}», escena «${sceneId}». Trabaja solo en esa escena y no crees escenas nuevas`;
  }
  return `proyecto «${projectId}»` + (sceneId ? `, escena «${sceneId}»` : '');
}
