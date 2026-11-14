import { Sparkles, Square, SquarePen } from 'lucide-react';

/** Paso's mark alone: the step glyph on its ink tile. */
function Mark() {
  return (
    <span className="brand__mark rail__mark" aria-hidden="true">
      <svg viewBox="0 0 16 16"><path d="M1.5 14.5h4v-4h4.5V6h4.5V1.5" /></svg>
    </span>
  );
}

/** The sidebar, folded: a narrow column with the mark and «Nuevo proyecto». The tab on its edge opens it. */
export function LeftRail({ onCreate }: { onCreate: () => void }) {
  return (
    <nav className="rail rail--left" aria-label="Diagramas">
      <Mark />
      <button type="button" className="icon-btn" aria-label="Nuevo proyecto" title="Nuevo proyecto" onClick={onCreate}>
        <SquarePen className="i" aria-hidden="true" />
      </button>
    </nav>
  );
}

type Working = {
  /** "Claude Code está cambiando el paso", said to screen readers and in the tooltip. */
  sentence: string;
  /** The step being changed, as a chip that jumps to it. */
  step?: { label: string; number: number; onOpen: () => void };
  onStop: () => void;
};

/**
 * The agent, folded: a narrow column with its mark and, while it works, which step and «Detener». The tab on its edge
 * opens it.
 */
export function RightRail({ working }: { working?: Working }) {
  return (
    <div className="rail rail--right">
      <span className="rail__agent" aria-hidden="true"><Sparkles className="i" /></span>
      {working && (
        <div className="rail__status" role="status" aria-label="Agente trabajando" title={working.sentence}>
          <span className="visually-hidden">{working.sentence}</span>
          <span className="rail__pulse" aria-hidden="true" />
          {working.step && (
            <button type="button" className="chip chip--agent" aria-label={working.step.label} title={working.step.label} onClick={working.step.onOpen}>{working.step.number}</button>
          )}
          <button type="button" className="icon-btn" aria-label="Detener" title="Detener" onClick={working.onStop}>
            <Square className="i" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
