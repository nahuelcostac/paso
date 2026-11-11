import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Eye, FilePlus, History, LoaderCircle, PanelRight, Pencil, Square, SquarePen, Trash2, TriangleAlert, Undo2, X } from 'lucide-react';
import type { Scene } from '@paso/shared';
import { ApiRequestError, UnavailableError, type AgentSessionInfo, type HarnessId, type RunSummary, type UndoPlan, type UndoWarning } from '../lib/api';
import { formatSteps } from '../lib/format';
import {
  HARNESS_EFFORTS, HARNESS_MODELS, HARNESS_NAMES, conversationKey, countRunChanges, undoErrorMessage, undoableRun, useAgent,
  type AgentStore, type AgentTurn, type ToolItem,
} from '../state/agent-store';
import { AgentPicker } from './AgentPicker';
import { ProviderIcon } from './ProviderIcon';
import { Dialog } from './Dialog';
import { Popover } from './Popover';
import { pad } from './StepFrame';
import '../styles/agent.css';

type Props = {
  store: AgentStore;
  projectId: string;
  projectName: string;
  scenes: Scene[];
  /** The scene in the address. The agent receives it until the person picks another target. */
  routeSceneId?: string;
  /** Under 1100px the panel is a drawer over the Storyboard. */
  narrow: boolean;
  open: boolean;
  onClose: () => void;
  onOpenStep: (sceneId: string, stepId: string) => void;
  /** Selects a scene, so the chat follows it: the scene the agent works on is the one selected in the sidebar. */
  onOpenScene: (sceneId: string) => void;
  /** False while the diagram's scenes are still loading: until then it is not known which scene the agent gets. */
  scenesReady: boolean;
  /** The handle on the panel's left edge that changes its width. */
  resizer?: React.ReactNode;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const clock = (iso?: string | null) => {
  const date = iso ? new Date(iso) : undefined;
  return date && !Number.isNaN(date.getTime()) ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';
};

/** Where a step is, in the words the board uses: its scene and its number. */
function locateStep(scenes: Scene[], stepId: string | undefined) {
  if (!stepId) return undefined;
  for (const [index, scene] of scenes.entries()) {
    const at = scene.stepIds.indexOf(stepId);
    if (at >= 0) return { scene, sceneNumber: index + 1, stepNumber: at + 1 };
  }
  return undefined;
}

const TOOL_WORDS: Record<string, [running: string, done: string]> = {
  list_projects: ['Leyendo los diagramas', 'Leyó los diagramas'],
  read_project: ['Leyendo el diagrama', 'Leyó el diagrama'],
  read_scene: ['Leyendo la escena', 'Leyó la escena'],
  read_step: ['Leyendo el paso', 'Leyó el paso'],
  get_step_image: ['Mirando el paso', 'Miró el paso'],
  create_scene: ['Creando una escena', 'Creó una escena'],
  create_step: ['Creando el paso', 'Creó el paso'],
  duplicate_step: ['Duplicando un paso', 'Duplicó un paso en'],
  update_step: ['Cambiando los detalles del paso', 'Cambió los detalles del paso'],
  delete_step: ['Borrando el paso', 'Borró el paso'],
  add_elements: ['Cambiando el paso', 'Cambió el paso'],
  update_elements: ['Cambiando el paso', 'Cambió el paso'],
  delete_elements: ['Cambiando el paso', 'Cambió el paso'],
};

function toolLabel(item: ToolItem, scenes: Scene[]) {
  const [running, done] = TOOL_WORDS[item.tool] ?? ['Usando una herramienta', 'Usó una herramienta'];
  const label = item.status === 'running' ? running : done;
  if (item.tool === 'read_scene' && item.sceneId) {
    const at = scenes.findIndex((scene) => scene.id === item.sceneId);
    if (at >= 0) return `${label} ${at + 1}`;
  }
  return label;
}

function ToolIcon({ item }: { item: ToolItem }) {
  if (item.status === 'running') return <LoaderCircle className="i i--spin" aria-hidden="true" />;
  if (item.status === 'error') return <TriangleAlert className="i" aria-hidden="true" />;
  if (item.tool === 'create_scene' || item.tool === 'create_step' || item.tool === 'duplicate_step') return <FilePlus className="i" aria-hidden="true" />;
  if (item.tool.endsWith('_elements') || item.tool === 'update_step' || item.tool === 'delete_step') return <Pencil className="i" aria-hidden="true" />;
  return <Eye className="i" aria-hidden="true" />;
}

/** The agent writes Markdown. Bold and inline code are kept as such; everything else stays plain text. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return <>{parts.map((part, index) => part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={index}>{part.slice(1, -1)}</code> : part)}</>;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <>{Math.max(0, Math.floor((now - since) / 1000))} s</>;
}

/** The service's undo warnings, in Spanish and in the board's terms. Codes it may add later still get a plain sentence. */
export function warningText(warning: UndoWarning, scenes: Scene[]) {
  const where = locateStep(scenes, warning.id);
  const step = where ? `el paso ${where.stepNumber} de «${where.scene.name}»` : warning.title ? `el paso «${warning.title}»` : 'un paso';
  const Step = step[0].toUpperCase() + step.slice(1);
  const sceneName = scenes.find((scene) => scene.id === (warning.kind === 'scene' ? warning.id : warning.sceneId))?.name;
  switch (warning.code) {
    case 'STEP_MODIFIED_CONCURRENTLY': return `Alguien editó ${step} mientras el agente trabajaba. Al deshacer también se pierden esas ediciones.`;
    case 'STEP_MODIFIED_AFTER_RUN': return `${Step} se editó después de la ejecución. Al deshacer se pierden esas ediciones.`;
    case 'STEP_DELETED': return `${Step} se borró después de la ejecución. Al deshacer vuelve a aparecer como estaba antes.`;
    case 'SCENE_DELETED': return 'Se borró una escena con un paso que cambió el agente. Ese paso no se puede recuperar.';
    case 'SCENE_HAS_POST_RUN_STEPS': return `${sceneName ? `La escena «${sceneName}»` : 'Una escena'} que creó el agente tiene pasos nuevos de otra persona. Se conserva, con esos pasos.`;
    case 'ORDER_MODIFIED_AFTER_RUN': return warning.kind === 'project'
      ? 'El orden de las escenas cambió después de la ejecución. Se recupera el anterior, con las escenas nuevas en su sitio.'
      : `El orden de los pasos${sceneName ? ` de «${sceneName}»` : ''} cambió después de la ejecución. Se recupera el anterior, con los pasos nuevos en su sitio.`;
    default: return 'Algo cambió después de la ejecución y deshacerla puede afectarlo.';
  }
}

function planLines(plan: UndoPlan) {
  const { stepsToRestore, stepsToDelete, stepsToRecreate, scenesToDelete, orderChanges } = plan.changes;
  const lines: string[] = [];
  if (stepsToRestore.length) lines.push(stepsToRestore.length === 1 ? 'Un paso recupera su contenido, título y notas anteriores.' : `${stepsToRestore.length} pasos recuperan su contenido, título y notas anteriores.`);
  if (stepsToDelete.length) lines.push(stepsToDelete.length === 1 ? 'Se borra un paso que creó el agente.' : `Se borran ${stepsToDelete.length} pasos que creó el agente.`);
  if (scenesToDelete.length) lines.push(scenesToDelete.length === 1 ? 'Se borra una escena que creó el agente.' : `Se borran ${scenesToDelete.length} escenas que creó el agente.`);
  if (stepsToRecreate.length) lines.push(stepsToRecreate.length === 1 ? 'Vuelve un paso borrado, con su contenido y en su posición anterior.' : `Vuelven ${stepsToRecreate.length} pasos borrados, con su contenido y en su posición anterior.`);
  if (!lines.length && orderChanges.length) lines.push('Se recupera el orden de antes.');
  return lines;
}

type UndoState = { runId: string; plan?: UndoPlan; busy: boolean; error?: string };

function UndoDialog({ state, scenes, onCancel, onConfirm }: {
  state: UndoState & { plan: UndoPlan }; scenes: Scene[]; onCancel: () => void; onConfirm: (force: boolean) => void;
}) {
  const { plan, busy, error } = state;
  const [understood, setUnderstood] = useState(false);
  // A new plan (the project changed meanwhile) needs a new decision, from its very first render.
  const [decidedFor, setDecidedFor] = useState(plan.confirmationToken);
  if (decidedFor !== plan.confirmationToken) { setDecidedFor(plan.confirmationToken); setUnderstood(false); }
  const lines = planLines(plan);
  return (
    <Dialog title="¿Deshacer esta ejecución?" onClose={() => { if (!busy) onCancel(); }}>
      <ul className="dialog__list undo__changes">
        {lines.length ? lines.map((line) => <li key={line}>{line}</li>) : <li>No queda nada que deshacer.</li>}
      </ul>
      {plan.warnings.length > 0 && (
        <ul className="undo__warnings" aria-label="Avisos">
          {plan.warnings.map((warning, index) => (
            <li key={`${warning.code}-${warning.id}-${index}`}><TriangleAlert className="i" aria-hidden="true" /><span>{warningText(warning, scenes)}</span></li>
          ))}
        </ul>
      )}
      {plan.requiresForce && (
        <label className="undo__confirm">
          <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
          <span>Entiendo que se perderán ediciones hechas por personas.</span>
        </label>
      )}
      {error && <p className="dialog__error" role="alert">{error}</p>}
      <div className="dialog__actions">
        <button type="button" className="btn btn--soft" data-autofocus disabled={busy} onClick={onCancel}>Cancelar</button>
        <button
          type="button" className={plan.requiresForce ? 'btn btn--danger' : 'btn btn--soft'}
          disabled={busy || !plan.canUndo || (plan.requiresForce && !understood)} onClick={() => onConfirm(plan.requiresForce)}
        >
          {plan.requiresForce ? 'Deshacer y perder las ediciones' : 'Deshacer ejecución'}
        </button>
      </div>
    </Dialog>
  );
}

/** The agent panel: a conversation with the person's own harness about this project, and what the agent does in it. */
export function AgentPanel({ store, projectId, projectName, scenes, routeSceneId, narrow, open, onClose, onOpenStep, onOpenScene, scenesReady, resizer }: Props) {
  const state = useAgent(store);
  const [input, setInput] = useState('');
  const [menu, setMenu] = useState<{ kind: 'history'; anchor: HTMLButtonElement } | null>(null);
  const [deleting, setDeleting] = useState<{ session: AgentSessionInfo; busy: boolean; error?: string } | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string>();
  const log = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { void store.loadHarnesses(); }, [store]);
  useEffect(() => { void store.openProject(projectId); }, [store, projectId]);
  // Opening the drawer puts the person in the composer.
  useEffect(() => { if (narrow && open) textarea.current?.focus(); }, [narrow, open]);

  // The scene the agent works on is the one selected in the sidebar: the scene in the address, or else the first one.
  // A diagram with no scenes yet is given to it whole.
  const targetSceneId = scenes.some((scene) => scene.id === routeSceneId) ? routeSceneId! : scenes[0]?.id ?? null;
  const targetIndex = scenes.findIndex((scene) => scene.id === targetSceneId);
  const targetScene = targetIndex >= 0 ? scenes[targetIndex] : undefined;
  const sessionId = state.conversation[conversationKey(projectId, targetSceneId)];
  const session = sessionId ? state.sessions[sessionId] : undefined;

  const turns = useMemo(() => state.turns.filter((turn) => sessionId && turn.sessionId === sessionId), [state.turns, sessionId]);
  const running = state.turns.find((turn) => turn.projectId === projectId && turn.status === 'running');
  const runningElsewhere = running && running.sessionId !== sessionId ? running : undefined;
  const runs = state.runs[projectId];
  const undoTarget = undoableRun(runs);
  const undoTargetShown = undoTarget && turns.some((turn) => turn.runId === undoTarget.id);

  // The pickers show the open conversation's harness and model; a change starts a new conversation.
  const harness: HarnessId = session?.harness ?? state.harness;
  const models = HARNESS_MODELS[harness];
  const model = models.find((option) => option.id === (session ? session.model ?? '' : state.model)) ?? models[0];
  // The reasoning effort is the window's choice for the next message, whatever conversation is open.
  const efforts = HARNESS_EFFORTS[harness];
  const effort = efforts.find((option) => option.id === state.effort) ?? efforts[0];
  const history = store.conversations(projectId, targetSceneId);
  const info = state.harnesses.list.find((candidate) => candidate.id === harness);
  const usable = Boolean(scenesReady && info?.supported && info.found && info.added && info.session !== 'signed_out');

  // The latest turn stays in view. A closed drawer cannot scroll, so it scrolls again when it opens.
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns, open]);

  const send = async () => {
    if (!usable || running || !input.trim()) return;
    const text = input;
    setInput('');
    if (!(await store.send(projectId, targetSceneId, text))) setInput(text);
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  const add = async (id: HarnessId) => {
    setAdding(true); setAddError(undefined);
    try { await store.addHarness(id); }
    catch (error) { setAddError(error instanceof ApiRequestError ? error.message : 'No se pudo añadir el asistente.'); }
    finally { setAdding(false); }
  };

  const startUndo = async (runId: string) => {
    setUndo({ runId, busy: true });
    try { setUndo({ runId, plan: await store.previewUndo(projectId, runId), busy: false }); }
    catch (error) { setUndo({ runId, busy: false, error: undoErrorMessage(error) }); }
  };
  const confirmUndo = async (force: boolean) => {
    if (!undo?.plan) return;
    const { runId, plan } = undo;
    setUndo({ ...undo, busy: true, error: undefined });
    try {
      await store.undo(projectId, runId, plan, force);
      setUndo(null);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.code === 'CONFIRMATION_MISMATCH' || error.code === 'FORCE_REQUIRED')) {
        // The project changed after the preview: show what undoing does now, and ask again.
        try {
          const fresh = await store.previewUndo(projectId, runId);
          setUndo({ runId, plan: fresh, busy: false, error: 'El diagrama cambió mientras mirabas el resumen. Revísalo de nuevo.' });
        } catch (again) { setUndo({ runId, plan, busy: false, error: undoErrorMessage(again) }); }
      } else {
        setUndo({ runId, plan, busy: false, error: undoErrorMessage(error) });
      }
    }
  };

  const undoButton = (runId: string) => (
    <button type="button" className="btn btn--bare" disabled={undo?.runId === runId && undo.busy} onClick={() => void startUndo(runId)}>
      <Undo2 className="i" aria-hidden="true" />Deshacer ejecución
    </button>
  );

  const runMeta = (turn: AgentTurn, run: RunSummary | undefined) => {
    const changes = run ? countRunChanges(run) : turn.entries.reduce((total, entry) => total + (entry.kind === 'work' ? entry.items.filter((item) => !item.readOnly && item.status === 'done').length : 0), 0);
    const parts = [
      turn.status === 'cancelled' ? 'Detenida' : turn.status === 'failed' ? 'Falló' : undefined,
      clock(run?.finishedAt ?? turn.endedAt),
      // A run without changes is undone silently on the way to an older one: it still changed nothing.
      changes === 0 ? 'Sin cambios' : run?.status === 'undone' ? 'Deshecha' : plural(changes, 'cambio', 'cambios'),
    ].filter(Boolean);
    return parts.join(' · ');
  };


  let harnessNotice: { text: string; action?: { label: string; run: () => void } } | undefined;
  if (state.harnesses.status === 'failed') {
    harnessNotice = { text: 'No se pudo comprobar qué asistentes hay en este equipo.', action: { label: 'Comprobar de nuevo', run: () => void store.loadHarnesses(true) } };
  } else if (info && !info.found) {
    harnessNotice = { text: `No se encuentra ${HARNESS_NAMES[harness]} en este equipo. Instálalo y vuelve a comprobarlo.`, action: { label: 'Comprobar de nuevo', run: () => void store.loadHarnesses(true) } };
  } else if (info && info.session === 'signed_out') {
    harnessNotice = { text: `${HARNESS_NAMES[harness]} no tiene la sesión iniciada. Inicia sesión en un terminal y vuelve a comprobarlo.`, action: { label: 'Comprobar de nuevo', run: () => void store.loadHarnesses(true) } };
  } else if (info && !info.added) {
    harnessNotice = {
      text: `Paso usará ${HARNESS_NAMES[harness]} con tu propia sesión y tu cuota. Solo tendrá las herramientas del tablero: no puede usar el terminal ni ver tus archivos.`,
      action: { label: adding ? 'Añadiendo…' : `Añadir ${HARNESS_NAMES[harness]}`, run: () => void add(harness) },
    };
  }

  return (
    <aside
      id="agent-panel" className="agent" aria-label="Agente" data-narrow={narrow || undefined} data-open={narrow && open ? 'true' : undefined}
      onKeyDown={(event) => { if (narrow && event.key === 'Escape' && !menu && !undo) { event.stopPropagation(); onClose(); } }}
    >
      {resizer}
      <div className="agent__head">
        {/* What the agent works on: the scene selected in the sidebar. There is nothing to pick here. */}
        <h2 className="agent__target" title={`${projectName} · ${targetScene ? targetScene.name : 'Todo el diagrama'}`}>
          {targetScene && <span className="agent__scene-num">{pad(targetIndex + 1)}</span>}
          <span className="agent__title">{targetScene ? targetScene.name : 'Todo el diagrama'}</span>
        </h2>
        <button
          type="button" className="icon-btn" aria-label="Historial de conversaciones" title="Historial de conversaciones"
          aria-haspopup="dialog" aria-expanded={menu?.kind === 'history'}
          onClick={(event) => setMenu(menu?.kind === 'history' ? null : { kind: 'history', anchor: event.currentTarget })}
        >
          <History className="i" aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-label="Nueva conversación" title="Nueva conversación" disabled={!sessionId} onClick={() => store.newConversation(projectId, targetSceneId)}>
          <SquarePen className="i" aria-hidden="true" />
        </button>
        {/* Folds the panel away, as the sidebar's own button does on the left. */}
        <button type="button" className="icon-btn" aria-label="Ocultar el agente" title="Ocultar el agente" onClick={onClose}>
          {narrow ? <X className="i" aria-hidden="true" /> : <PanelRight className="i" aria-hidden="true" />}
        </button>
      </div>

      <div ref={log} className="agent__log" role="log" aria-label="Conversación con el agente">
        {undoTarget && !undoTargetShown && (
          <div className="run-end run-end--earlier">
            <span>Última ejecución · {clock(undoTarget.finishedAt)} · {plural(countRunChanges(undoTarget), 'cambio', 'cambios')}</span>
            <span className="spacer" />
            {!running && undoButton(undoTarget.id)}
          </div>
        )}

        {turns.map((turn) => {
          const run = runs?.find((candidate) => candidate.id === turn.runId);
          return (
            <div key={turn.runId} className="agent__turn">
              {turn.userText && <p className="msg-user">{turn.userText}</p>}
              {turn.entries.map((entry, index) => entry.kind === 'text' ? (
                <p key={entry.id} className="msg-agent">
                  <Inline text={entry.text} />
                  {turn.status === 'running' && index === turn.entries.length - 1 && <span className="caret" aria-hidden="true" />}
                </p>
              ) : (
                <ul key={entry.id} className="work">
                  {entry.items.map((item) => {
                    const where = locateStep(scenes, item.stepId);
                    const scene = scenes.find((candidate) => candidate.id === item.sceneId);
                    return (
                      <li key={item.id}>
                        <ToolIcon item={item} />
                        <span className={item.status === 'running' ? 'work__now' : undefined}>{toolLabel(item, scenes)}</span>
                        {where && item.stepId && (
                          <button
                            type="button" className="chip chip--agent"
                            aria-label={`Ir al paso ${where.stepNumber} de la escena ${where.sceneNumber}`}
                            title={`Escena ${where.sceneNumber} · ${where.scene.name}`}
                            onClick={() => onOpenStep(where.scene.id, item.stepId!)}
                          >{where.stepNumber}</button>
                        )}
                        {item.status === 'error' ? <span className="work__detail">no se pudo</span>
                          : item.tool === 'read_scene' && scene ? <span className="work__detail">{formatSteps(scene.stepIds.length)}</span>
                            : null}
                      </li>
                    );
                  })}
                </ul>
              ))}
              {turn.status === 'failed' && turn.errorMessage && (
                <div className="notice notice--error" role="alert"><TriangleAlert className="i" aria-hidden="true" /><span>{turn.errorMessage}</span></div>
              )}
              {turn.status === 'running' ? (
                <p className="working">Trabajando · <Elapsed since={turn.startedAt} /></p>
              ) : (
                <div className="run-end">
                  <span>{runMeta(turn, run)}</span>
                  <span className="spacer" />
                  {undoTarget?.id === turn.runId && !running && undoButton(turn.runId)}
                </div>
              )}
            </div>
          );
        })}

        {runningElsewhere && (
          <div className="notice" role="status">
            <LoaderCircle className="i i--spin" aria-hidden="true" />
            <div className="notice__body">
              <span>{HARNESS_NAMES[runningElsewhere.harness]} está trabajando en {runningElsewhere.sceneId ? `la escena ${scenes.findIndex((scene) => scene.id === runningElsewhere.sceneId) + 1}` : 'todo el diagrama'}.</span>
              <button type="button" className="notice__action" onClick={() => { if (runningElsewhere.sceneId) onOpenScene(runningElsewhere.sceneId); }}>Ver la conversación</button>
            </div>
          </div>
        )}
        {undo && !undo.plan && undo.error && (
          <div className="notice notice--error" role="alert">
            <TriangleAlert className="i" aria-hidden="true" /><span>{undo.error}</span>
            <button type="button" className="icon-btn" aria-label="Cerrar aviso" onClick={() => setUndo(null)}><X className="i" aria-hidden="true" /></button>
          </div>
        )}
        {state.notice[projectId] && (
          <div className="notice notice--error" role="alert">
            <TriangleAlert className="i" aria-hidden="true" /><span>{state.notice[projectId]}</span>
            <button type="button" className="icon-btn" aria-label="Cerrar aviso" onClick={() => store.clearNotice(projectId)}><X className="i" aria-hidden="true" /></button>
          </div>
        )}
        {harnessNotice && (
          <div className="notice">
            <div className="notice__body">
              <span>{harnessNotice.text}</span>
              {addError && <span className="notice__error">{addError}</span>}
              {harnessNotice.action && <button type="button" className="notice__action" disabled={adding} onClick={harnessNotice.action.run}>{harnessNotice.action.label}</button>}
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          ref={textarea} className="composer__input" rows={2} placeholder="Pide un cambio…" aria-label="Mensaje para el agente"
          value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKey}
        />
        <div className="composer__foot">
          <AgentPicker
            harnesses={state.harnesses.list} loading={state.harnesses.status === 'loading'}
            harness={harness} model={model.id} effort={effort?.id ?? ''}
            onPick={(choice) => store.choose(projectId, targetSceneId, choice)}
            onPickEffort={(id) => store.chooseEffort(id)}
            onRefresh={() => void store.loadHarnesses(true)}
          />
          <span className="spacer" />
          {running ? (
            <button type="button" className="composer__send" aria-label="Detener" title="Detener" onClick={() => void store.stop(projectId)}>
              <Square className="i" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="composer__send" aria-label="Enviar" title="Enviar" disabled={!usable || !input.trim()} onClick={() => void send()}>
              <ArrowUp className="i" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {menu?.kind === 'history' && (
        <HistoryPopover
          anchor={menu.anchor} conversations={history} current={sessionId} onClose={() => setMenu(null)}
          onOpen={(id) => { setMenu(null); menu.anchor.focus(); void store.openConversation(projectId, targetSceneId, id); }}
          onDelete={(picked) => { setMenu(null); setDeleting({ session: picked, busy: false }); }}
        />
      )}
      {deleting && (
        <Dialog title="¿Borrar esta conversación?" onClose={() => { if (!deleting.busy) setDeleting(null); }}>
          <p className="dialog__text">
            Se borran sus mensajes de Paso y la copia que guarda {HARNESS_NAMES[deleting.session.harness]} en este equipo. No se puede deshacer.
            Lo que el agente cambió en el diagrama se queda, y se puede seguir deshaciendo.
          </p>
          {deleting.error && <p className="dialog__error" role="alert">{deleting.error}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus onClick={() => setDeleting(null)}>Cancelar</button>
            <button
              type="button" className="btn btn--danger" disabled={deleting.busy}
              onClick={async () => {
                setDeleting({ ...deleting, busy: true, error: undefined });
                try { await store.deleteConversation(deleting.session.id); setDeleting(null); }
                catch (error) {
                  setDeleting({ ...deleting, busy: false, error: error instanceof UnavailableError ? 'No hay conexión con el servicio local.' : error instanceof ApiRequestError ? error.message : 'No se pudo borrar la conversación.' });
                }
              }}
            >Borrar conversación</button>
          </div>
        </Dialog>
      )}
      {undo?.plan && <UndoDialog state={{ ...undo, plan: undo.plan }} scenes={scenes} onCancel={() => setUndo(null)} onConfirm={(force) => void confirmUndo(force)} />}
    </aside>
  );
}

const whenLabel = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === today.toDateString()) return `hoy, ${time}`;
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `ayer, ${time}`;
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
};

/**
 * The scene's earlier conversations, newest first: each one by its first message, with who answered and when. A click
 * opens it, so the next message continues it; the bin deletes it after asking.
 */
function HistoryPopover({ anchor, conversations, current, onClose, onOpen, onDelete }: {
  anchor: HTMLElement; conversations: AgentSessionInfo[]; current: string | undefined; onClose: () => void;
  onOpen: (id: string) => void; onDelete: (session: AgentSessionInfo) => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <Popover anchor={anchor} align="end" onClose={onClose} role="dialog" label="Historial de conversaciones" className="menu history">
      <p className="history__head">Conversaciones de esta escena</p>
      {conversations.length === 0 ? <p className="menu__empty">Aún no hay conversaciones en esta escena.</p> : (
        <ul className="history__list">
          {conversations.map((conversation, index) => {
            const modelLabel = HARNESS_MODELS[conversation.harness].find((option) => option.id === (conversation.model ?? ''))?.label ?? conversation.model;
            const title = conversation.title || 'Conversación sin título';
            const running = conversation.state === 'running';
            return (
              <li key={conversation.id} className="history__item" data-current={conversation.id === current || undefined}>
                <button ref={index === 0 ? first : undefined} type="button" className="history__open" aria-current={conversation.id === current ? 'true' : undefined} onClick={() => onOpen(conversation.id)}>
                  <span className="history__title">{title}</span>
                  <span className="history__meta">
                    <ProviderIcon id={conversation.harness} size={12} />
                    {running ? 'Trabajando… · ' : ''}{HARNESS_NAMES[conversation.harness]}{modelLabel && modelLabel !== 'Predeterminado' ? ` · ${modelLabel}` : ''} · {plural(conversation.turns, 'mensaje', 'mensajes')} · {whenLabel(conversation.updatedAt)}
                  </span>
                </button>
                <button
                  type="button" className="icon-btn history__delete" aria-label={`Borrar la conversación «${title}»`} title={running ? 'Detén al agente para poder borrarla' : 'Borrar conversación'}
                  disabled={running} onClick={() => onDelete(conversation)}
                >
                  <Trash2 className="i" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
}
