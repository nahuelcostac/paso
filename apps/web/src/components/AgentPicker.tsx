import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import type { HarnessId } from '../lib/api';
import { HARNESS_EFFORTS, HARNESS_MODELS, HARNESS_NAMES, type HarnessInfo } from '../state/agent-store';
import { Popover } from './Popover';
import { ProviderIcon } from './ProviderIcon';

/** Levels drawn as bars. `max` is named instead, and automatic draws nothing. */
const NAMED_LEVELS = new Set(['max']);

/** Rising bars, filled up to the chosen level, as in T3 Code. They take the colour of the text. */
export function EffortBars({ harness, effort }: { harness: HarnessId; effort: string }) {
  const levels = HARNESS_EFFORTS[harness].filter((option) => option.id && !NAMED_LEVELS.has(option.id));
  const filled = levels.findIndex((option) => option.id === effort) + 1;
  if (!filled) return null;
  const height = 12, step = 4, width = step * levels.length - 2;
  return (
    <svg className="effort-bars" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {levels.map((option, index) => {
        const bar = Math.round(height / 2 + (index * (height / 2)) / Math.max(1, levels.length - 1));
        return <rect key={option.id} x={index * step} y={height - bar} width={2} height={bar} rx={1} opacity={index < filled ? 1 : 0.3} />;
      })}
    </svg>
  );
}

/** Why an agent's models cannot be picked. While detection runs nothing is known yet, and the models stay available. */
function harnessStatus(info: HarnessInfo | undefined) {
  if (!info) return undefined;
  if (!info.found) return `No se encuentra ${HARNESS_NAMES[info.id]} en este equipo.`;
  if (!info.supported) return `${HARNESS_NAMES[info.id]} todavía no se puede usar desde Paso.`;
  return undefined;
}

type Props = {
  harnesses: HarnessInfo[];
  loading: boolean;
  /** The conversation's harness and model, and the reasoning effort for the next message. */
  harness: HarnessId;
  model: string;
  effort: string;
  onPick: (choice: { harness: HarnessId; model: string }) => void;
  onPickEffort: (effort: string) => void;
  onRefresh: () => void;
};

/**
 * The agent, model and reasoning, in one control. The trigger names the model, with the agent's mark before it and
 * the reasoning as bars after it. The popup has three columns: the agents, the models of the one in view, and the
 * levels of the chosen one, with the default marked. Picking a model keeps it open on the levels.
 */
export function AgentPicker({ harnesses, loading, harness, model, effort, onPick, onPickEffort, onRefresh }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const models = HARNESS_MODELS[harness];
  const modelLabel = models.find((option) => option.id === model)?.label ?? model;
  const effortOption = HARNESS_EFFORTS[harness].find((option) => option.id === effort);
  const named = effortOption && NAMED_LEVELS.has(effortOption.id);
  const label = [HARNESS_NAMES[harness], modelLabel, effortOption?.id ? `razonamiento ${effortOption.label.toLowerCase()}` : ''].filter(Boolean).join(', ');
  return (
    <>
      <button
        ref={trigger} type="button" className="composer__control agent-picker__trigger" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Agente y modelo: ${label}`} title="Agente, modelo y razonamiento"
        onClick={() => setOpen(!open)}
      >
        <ProviderIcon id={harness} />
        <span className="agent-picker__model">{modelLabel}</span>
        {named ? <span className="agent-picker__effort">{effortOption!.label}</span> : <EffortBars harness={harness} effort={effort} />}
        <ChevronDown className="i" aria-hidden="true" />
      </button>
      {open && trigger.current && (
        <PickerPopup
          anchor={trigger.current} harnesses={harnesses} loading={loading} harness={harness} model={model} effort={effort}
          onClose={() => { setOpen(false); trigger.current?.focus(); }}
          onPick={onPick} onPickEffort={(id) => { onPickEffort(id); setOpen(false); trigger.current?.focus(); }} onRefresh={onRefresh}
        />
      )}
    </>
  );
}

/** Up and Down move within a column; Left and Right move between columns. */
function columnKeys(event: KeyboardEvent<HTMLDivElement>) {
  const column = (event.target as HTMLElement).closest<HTMLElement>('[data-picker-column]');
  if (!column) return;
  const rows = () => [...column.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[Math.min(all.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    event.preventDefault();
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    const columns = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-picker-column]')];
    const next = columns[columns.indexOf(column) + (event.key === 'ArrowRight' ? 1 : -1)];
    const target = next?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]:not(:disabled)') ?? next?.querySelector<HTMLButtonElement>('[role="radio"]:not(:disabled)');
    if (target) { target.focus(); event.preventDefault(); }
  }
}

function PickerPopup({ anchor, harnesses, loading, harness, model, effort, onClose, onPick, onPickEffort, onRefresh }: Omit<Props, 'onPickEffort'> & {
  anchor: HTMLElement; onClose: () => void; onPickEffort: (effort: string) => void;
}) {
  // The agent in view in the middle column. It becomes the conversation's only when one of its models is picked.
  const [viewing, setViewing] = useState<HarnessId>(harness);
  const root = useRef<HTMLDivElement>(null);
  const focusEfforts = useRef(false);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('[data-picker-column="models"] [role="radio"][aria-checked="true"]')?.focus();
  }, []);
  // After a model pick the levels take the focus, as in T3 Code.
  useEffect(() => {
    if (!focusEfforts.current) return;
    focusEfforts.current = false;
    root.current?.querySelector<HTMLButtonElement>('[data-picker-column="efforts"] [role="radio"][aria-checked="true"]')?.focus();
  }, [harness, model]);
  const info = harnesses.find((candidate) => candidate.id === viewing);
  const status = harnessStatus(info);
  const efforts = HARNESS_EFFORTS[harness];
  const modelLabel = HARNESS_MODELS[harness].find((option) => option.id === model)?.label ?? model;
  return (
    <Popover anchor={anchor} onClose={onClose} role="dialog" label="Elegir agente y modelo" className="agent-picker" onKeyDown={columnKeys}>
      <div ref={root} className="agent-picker__columns">
        <div className="agent-picker__rail" role="radiogroup" aria-label="Agente" data-picker-column="harnesses">
          {(harnesses.length ? harnesses.map((item) => item.id) : (['claude', 'codex', 'agy'] as HarnessId[])).map((id) => (
            <button
              key={id} type="button" role="radio" aria-checked={id === viewing} aria-label={HARNESS_NAMES[id]} title={HARNESS_NAMES[id]}
              className="agent-picker__harness" tabIndex={id === viewing ? 0 : -1} onClick={() => setViewing(id)}
            >
              <ProviderIcon id={id} size={20} />
            </button>
          ))}
        </div>
        <div className="agent-picker__models" data-picker-column="models">
          <div className="agent-picker__head"><span>{HARNESS_NAMES[viewing]}</span>{info?.version && <span className="agent-picker__note">{info.version.replace(/\s*\(.*\)$/, '')}</span>}</div>
          {status ? (
            <div className="agent-picker__status">
              <p>{status}</p>
              <button type="button" className="btn btn--soft" disabled={loading} onClick={onRefresh}>
                <RefreshCw className={`i${loading ? ' i--spin' : ''}`} aria-hidden="true" />Detectar de nuevo
              </button>
            </div>
          ) : (
            <div role="radiogroup" aria-label="Modelo" className="agent-picker__list">
              {HARNESS_MODELS[viewing].map((option) => {
                const chosen = viewing === harness && option.id === model;
                return (
                  <button
                    key={option.id || 'default'} type="button" role="radio" aria-checked={chosen} tabIndex={chosen ? 0 : -1}
                    className="agent-picker__row"
                    onClick={() => {
                      focusEfforts.current = HARNESS_EFFORTS[viewing].length > 0;
                      onPick({ harness: viewing, model: option.id });
                      if (!HARNESS_EFFORTS[viewing].length) onClose();
                    }}
                  >
                    <span className="agent-picker__label">{option.label}</span>
                    {chosen && <Check className="i" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
          {info && !status && !info.added && <p className="agent-picker__hint">Al elegirlo, Paso te pedirá permiso para usarlo con tu sesión.</p>}
        </div>
        <div className="agent-picker__efforts" data-picker-column="efforts">
          <div className="agent-picker__head"><span>Razonamiento</span><span className="agent-picker__note">{modelLabel}</span></div>
          {efforts.length ? (
            <div role="radiogroup" aria-label="Razonamiento" className="agent-picker__list">
              {efforts.map((option) => {
                const chosen = option.id === effort;
                return (
                  <button
                    key={option.id || 'auto'} type="button" role="radio" aria-checked={chosen} tabIndex={chosen ? 0 : -1}
                    className="agent-picker__row" onClick={() => onPickEffort(option.id)}
                  >
                    <span className="agent-picker__label">{option.label}</span>
                    {chosen && <Check className="i" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          ) : <p className="agent-picker__empty">Sin niveles de razonamiento</p>}
        </div>
      </div>
    </Popover>
  );
}
