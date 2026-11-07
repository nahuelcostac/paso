import { useEffect, useState, type ComponentPropsWithRef } from 'react';
import '../styles/step-frame.css';

export type StepFrameProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'title'> & {
  /** Position in its scene, from 1. Always shown, as two digits. */
  number: number;
  /** The step's optional title. */
  title?: string;
  /** The step open in the Lienzo: a 2px ink edge and a lime number. */
  current?: boolean;
  /** The step drawn by the thumbnail service, as an SVG document. Without it a quiet placeholder shows. */
  svg?: string;
  /**
   * `storyboard` puts the title after the number, truncated. `carousel` has no room for it: the
   * number stands alone and the title is only the tooltip.
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
 * A numbered step thumbnail: a 16:10 sheet of paper with its number below, never on it. The
 * drawing is already drawn for the current theme, so no colour filter is applied to it.
 * Anything else a button takes, such as `onClick` or `ref`, goes to the button.
 */
export function StepFrame({ number, title, current = false, svg, size = 'storyboard', className = '', ...button }: StepFrameProps) {
  const url = useSvgUrl(svg);
  return (
    <button
      type="button"
      className={`frame frame--${size} ${className}`.trim()}
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
        {title && size === 'storyboard' && <span className="frame__title">{title}</span>}
      </span>
    </button>
  );
}
