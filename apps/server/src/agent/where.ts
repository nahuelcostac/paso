import { isLooseProject } from '@paso/shared';

/** Where a run works, said in the agent's instructions with the service IDs. It follows “You are working in the …”. */
export function describeTarget({ projectId, sceneId }: { projectId: string; sceneId?: string }) {
  // A loose diagram is one scene of a reserved project that lists of projects never show.
  if (isLooseProject(projectId) && sceneId) {
    return `loose diagram: reserved project "${projectId}", scene "${sceneId}". Work only in that scene and do not create new scenes`;
  }
  return `project "${projectId}"` + (sceneId ? `, scene "${sceneId}"` : '');
}

/**
 * The steps the person attached to this message, said in the agent's instructions after where it works. Only service
 * IDs: the model reads the steps itself with the board tools. Empty when the message names none.
 */
export function describeSteps(steps: { sceneId: string; stepId: string }[] | undefined) {
  if (!steps?.length) return '';
  const list = steps.map((step) => `step "${step.stepId}" in scene "${step.sceneId}"`).join(', ');
  const one = steps.length === 1;
  return ` The person attached ${one ? 'a step' : `${steps.length} steps`} to this message: ${list}. ` +
    `Work on ${one ? 'that step' : 'those steps'} with the board tools, and leave the other steps as they are unless the message asks for more.`;
}
