import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import type { Scene } from '@paso/shared';
import { Popover } from './Popover';

type Props = {
  scenes: Scene[] | undefined;
  currentId: string | undefined;
  busy: boolean;
  onSelect: (sceneId: string) => void;
  onCreate: () => void;
};

/** The scene switcher in the top bar: a glass pill with the scene's number and name, and a menu to switch or create one. */
export function SceneSelector({ scenes, currentId, busy, onSelect, onCreate }: Props) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  // The menu mounts in the same commit that sets `open`: wait one frame so its items exist.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => (items().find((item) => item.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!scenes) return null;
  const at = scenes.findIndex((scene) => scene.id === currentId);
  const current = scenes[at];
  // Nothing to switch between yet: the control is just the way to the first scene.
  if (scenes.length === 0) {
    return <button type="button" className="select glass" disabled={busy} onClick={onCreate}><Plus className="i" aria-hidden="true" /><span className="select__name">Nueva escena</span></button>;
  }
  const move = (to: number | 'first' | 'last') => {
    const all = items();
    const from = all.indexOf(document.activeElement as HTMLElement);
    all[to === 'first' ? 0 : to === 'last' ? all.length - 1 : (from + to + all.length) % all.length]?.focus();
  };
  return <>
    <button
      type="button" ref={setAnchor} className="select glass" aria-haspopup="menu" aria-expanded={open}
      aria-label={`Escena: ${current?.name ?? 'sin elegir'}. Cambiar de escena`}
      title={current?.name} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}
    >
      <span className="select__num" aria-hidden="true">{at >= 0 ? at + 1 : '–'}</span>
      <span className="select__name">{current?.name ?? 'Elige una escena'}</span>
      <ChevronDown className="i" aria-hidden="true" />
    </button>
    {open && anchor && <Popover
      anchor={anchor} onClose={() => setOpen(false)} role="menu" label="Escenas" className="menu menu--scenes"
      onKeyDown={(event) => {
        const keys: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
        if (event.key in keys) { event.preventDefault(); move(keys[event.key]); }
      }}
    >
      <div ref={list}>
        {scenes.map((scene, index) => (
          <button key={scene.id} type="button" role="menuitemradio" aria-checked={scene.id === currentId} onClick={() => { setOpen(false); anchor.focus(); if (scene.id !== currentId) onSelect(scene.id); }}>
            <span className="menu__num">{index + 1}</span>
            <span className="menu__label">{scene.name}</span>
            {scene.id === currentId && <Check className="i" aria-hidden="true" />}
          </button>
        ))}
        <hr />
        <button type="button" role="menuitem" disabled={busy} onClick={() => { setOpen(false); anchor.focus(); onCreate(); }}><Plus className="i" aria-hidden="true" /><span className="menu__label">Nueva escena</span></button>
      </div>
    </Popover>}
  </>;
}
