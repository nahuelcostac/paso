import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { pad } from '../components/StepFrame';

/** Above this many steps the bar drops the ticks and keeps the numbers, as Present's pager does. */
const MAX_TICKS = 24;

/**
 * The foot of the Canvas, under the step strip, and still there when the strip is hidden. Present's pager in the
 * middle, the steps as ticks on the left while the strip is hidden, and a chevron on the right, which shows and hides
 * the strip. The bar keeps its height and place, so the chevron never moves under the pointer.
 */
export function StepBar({ stepIds, currentId, stripShown, onToggle, onStep }: {
  stepIds: string[];
  currentId: string | undefined;
  stripShown: boolean;
  onToggle: () => void;
  onStep: (delta: -1 | 1) => void;
}) {
  const count = stepIds.length;
  const index = currentId ? stepIds.indexOf(currentId) : -1;
  return <div className="step-bar">
    {!stripShown && count > 1 && count <= MAX_TICKS && <span className="step-bar__ticks" aria-hidden="true">
      {stepIds.map((id, position) => <i key={id} className={position === index ? 'on' : undefined} />)}
    </span>}
    {count > 1 && <div className="step-bar__pager" role="group" aria-label="Step navigation">
      <button type="button" className="step-bar__arrow" aria-label="Previous step" title="Previous step (←)" disabled={index <= 0} onClick={() => onStep(-1)}>
        <ChevronLeft className="i" aria-hidden="true" />
      </button>
      <span className="step-bar__where">
        <span className="visually-hidden">{index < 0 ? `${count} steps` : `Step ${index + 1} of ${count}`}</span>
        <span aria-hidden="true" data-testid="step-count"><b>{index < 0 ? '–' : pad(index + 1)}</b> / {pad(count)}</span>
      </span>
      <button type="button" className="step-bar__arrow" aria-label="Next step" title="Next step (→)" disabled={index < 0 || index >= count - 1} onClick={() => onStep(1)}>
        <ChevronRight className="i" aria-hidden="true" />
      </button>
    </div>}
    <button
      type="button" className="step-bar__toggle" aria-expanded={stripShown} aria-label={stripShown ? 'Hide steps' : 'Show steps'}
      title={stripShown ? 'Hide steps' : 'Show steps'} onClick={onToggle}
    >
      {stripShown ? <ChevronDown className="i" aria-hidden="true" /> : <ChevronUp className="i" aria-hidden="true" />}
    </button>
  </div>;
}
