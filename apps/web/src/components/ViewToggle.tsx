import { LayoutGrid, PenTool } from 'lucide-react';
import type { Route } from '../lib/route';

const VIEWS = [
  { view: 'canvas', label: 'Canvas', title: 'Canvas: draw the steps one by one', Icon: PenTool },
  { view: 'storyboard', label: 'Studio', title: "Studio: the scene's steps and the agent", Icon: LayoutGrid },
] as const;

/**
 * The two views of a diagram, as one switch. It sits in the same corner in both, under Present, so going and coming
 * back is the same gesture, and it shows which view is open.
 */
export function ViewToggle({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="View">
      {VIEWS.map(({ view, label, title, Icon }) => {
        const current = route.view === view;
        return (
          <button
            key={view} type="button" className="view-toggle__option" aria-pressed={current} title={title}
            onClick={() => { if (!current) navigate({ ...route, view }); }}
          >
            <Icon className="i" aria-hidden="true" /><span className="view-toggle__label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
