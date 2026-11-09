import { useEffect, useState, type ComponentPropsWithRef } from 'react';
import '../styles/step-frame.css';

export type StepFrameProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'title'> & {
  /** Position in its scene, from 1. Always shown, as two digits. */
  number: number;
  /** The step's optional title. */
  title?: string;
  /** The step open in the Lienzo: an ink edge and an ink number. */
  current?: boolean;
  /** Whether the agent is changing this step right now or changed it in an active run. */
  agentState?: 'working' | 'changed';
  /** The step drawn by the thumbnail service, as an SVG document. Without it a quiet placeholder shows. */
  svg?: string;
  /**
   * `storyboard` is a card: the number on the drawing's corner, the title below it, truncated. `carousel` has no
   * room for a title: the number stands alone under the drawing and the title is only the tooltip.
   */
  size?: 'storyboard' | 'carousel';
};

export const pad = (value: number) => String(value).padStart(2, '0');

/** The SVG as an image address. It lives as long as the frame shows that drawing. */
function useSvgUrl(svg: string | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!svg) { setUrl(undefined); return; }
    if (typeof URL.createObjectURL !== 'function') { setUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`); return; }
    const made = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [svg]);
  return url;
}

/**
 * A numbered step thumbnail: a 16:10 sheet of paper and its number. The
 * drawing is already drawn for the current theme, so no colour filter is applied to it.
 * Anything else a button takes, such as `onClick` or `ref`, goes to the button.
 */
export function StepFrame({ number, title, current = false, agentState, svg, size = 'storyboard', className = '', ...button }: StepFrameProps) {
  const url = useSvgUrl(svg);
  const workingClass = agentState === 'working' ? 'frame--agent-working' : '';
  return (
    <button
      type="button"
      className={`frame frame--${size} ${workingClass} ${className}`.replace(/\s+/g, ' ').trim()}
      aria-current={current ? 'step' : undefined}
      aria-label={`Paso ${number}${title ? `: ${title}` : ''}`}
      title={title}
      {...button}
    >
      <span className="frame__paper" data-state={url ? 'ready' : 'loading'}>
        {url ? <img src={url} alt="" draggable={false} /> : <span className="frame__placeholder" aria-hidden="true" />}
      </span>
      <span className="frame__label">
        <span className="frame__num">{pad(number)}</span>
        {agentState && (
          <span className="chip chip--agent">
            {agentState === 'working' ? (size === 'carousel' ? 'agente\u2026' : 'cambiando\u2026') : 'agente'}
          </span>
        )}
        {size === 'storyboard' && (title ? <span className="frame__title">{title}</span> : <span className="frame__title frame__title--empty" aria-hidden="true" />)}
      </span>
    </button>
  );
}
