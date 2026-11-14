import { Square } from 'lucide-react';

export type Working = {
  /** "Claude Code está cambiando el paso", said to screen readers and in the tooltip. */
  sentence: string;
  /** The step being changed, as a chip that jumps to it. */
  step?: { label: string; number: number; onOpen: () => void };
  onStop: () => void;
};

/**
 * The agent at work with its panel folded away: a small floating pill at the foot of the Estudio, by the chat's tab, with
 * a pink pulse, the step it is changing and «Detener». Folded, the side keeps nothing else.
 */
export function AgentWorking({ working }: { working: Working }) {
  return (
    <div className="agent-working" role="status" aria-label="Agente trabajando" title={working.sentence}>
      <span className="visually-hidden">{working.sentence}</span>
      <span className="agent-working__pulse" aria-hidden="true" />
      {working.step && (
        <button type="button" className="chip chip--agent" aria-label={working.step.label} title={working.step.label} onClick={working.step.onOpen}>{working.step.number}</button>
      )}
      <button type="button" className="icon-btn" aria-label="Detener" title="Detener" onClick={working.onStop}>
        <Square className="i" aria-hidden="true" />
      </button>
    </div>
  );
}
