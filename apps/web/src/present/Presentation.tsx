import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ApiClient } from '../lib/api';
import { Brand } from '../components/Brand';
import { pad } from '../components/StepFrame';
import { ApiRequestError } from '../lib/api';
import type { ServiceEvent } from '../state/projects-store';
import { useTheme } from '../editor/use-theme';
import { anchorRect, presentationFrame, type Viewport } from './framing';
import type { PresentFullscreen } from './fullscreen';
import { clickAction, keyAction, moveIndex, preparationOrder, type PresentAction } from './navigation';
import { loadDeck, pageKey, renderPage, type Deck, type Page } from './pages';
import { PageQueue, type QueueResult } from './page-queue';

/** How long the pointer must rest before it hides. */
const CURSOR_IDLE_MS = 2000;
/** Saving one change emits several events. */
const RELOAD_DELAY_MS = 150;
/** More ticks than this would not fit: the numbers alone say where you are. */
const MAX_TICKS = 24;

const viewportNow = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });
const deckSignature = (deck: Deck) => JSON.stringify(deck.steps.map((step) => [step.id, step.revision]));

/** Hides the pointer once it rests. Browsers send moves with the same coordinates when the layout changes, and those do not count. */
function useIdleCursor(delay: number) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), delay);
    let last: { x: number; y: number } | undefined;
    const move = (event: MouseEvent) => {
      if (last?.x === event.clientX && last.y === event.clientY) return;
      last = { x: event.clientX, y: event.clientY };
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), delay);
    };
    window.addEventListener('mousemove', move);
    return () => { clearTimeout(timer); window.removeEventListener('mousemove', move); };
  }, [delay]);
  return idle;
}

/** What is on screen. It changes only on a new view of a step, so a change on the service does not redraw the step being presented. */
type Shown = { identity: string; result: QueueResult<Page>; previous?: Page };

/**
 * The fullscreen presentation of one scene. It reads steps from the service only: everything was saved before it opened.
 * `onLeave` receives the step last shown, and a message when the presentation could not go on.
 */
export default function Presentation({ api, projectId, sceneId, startStepId, subscribeEvents, fullscreen, onLeave }: {
  api: ApiClient; projectId: string; sceneId: string; startStepId: string | undefined;
  subscribeEvents: (listener: (event: ServiceEvent) => void) => () => void;
  fullscreen: PresentFullscreen;
  onLeave: (lastStepId: string | undefined, message?: string) => void;
}) {
  const theme = useTheme();
  const root = useRef<HTMLDivElement>(null);
  const [deck, setDeck] = useState<Deck>();
  const [currentId, setCurrentId] = useState(startStepId);
  const [viewport, setViewport] = useState(viewportNow);
  const [shown, setShown] = useState<Shown>();
  const [progress, setProgress] = useState(0);
  const idle = useIdleCursor(CURSOR_IDLE_MS);

  const queue = useMemo(() => new PageQueue<Page>(() => setProgress((value) => value + 1), (page) => URL.revokeObjectURL(page.url)), []);
  useEffect(() => () => queue.dispose(), [queue]);

  // A step deleted during the presentation leaves its place to the one now at that position.
  const lastIndex = useRef(0);
  const found = deck ? deck.steps.findIndex((step) => step.id === currentId) : -1;
  const index = !deck ? -1 : found >= 0 ? found : Math.min(lastIndex.current, deck.steps.length - 1);
  if (index >= 0) lastIndex.current = index;
  const step = deck?.steps[index];
  const stepId = step?.id;

  const leave = useRef(onLeave);
  const lastShownId = useRef(stepId ?? startStepId);
  // Written during render on purpose: leaving must name the step on screen, even if it happens before any effect runs.
  leave.current = onLeave;
  if (stepId) lastShownId.current = stepId;
  const exit = useCallback((message?: string) => leave.current(lastShownId.current, message), []);

  useEffect(() => { root.current?.focus(); }, []);
  useEffect(() => fullscreen.onBrowserExit(() => exit()), [fullscreen, exit]);
  useEffect(() => {
    const resize = () => setViewport(viewportNow());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // The service is the source: read it at the start and again whenever this scene changes there.
  const signature = useRef<string>(undefined);
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    let next: Deck;
    try { next = await loadDeck(api, projectId, sceneId); }
    catch (error) {
      if (mine !== reads.current) return;
      if (signature.current === undefined) exit('No se pudo preparar la presentación.');
      else if (error instanceof ApiRequestError && error.status === 404) exit('La escena que presentabas ya no existe.');
      // Otherwise the service is away for now. What is ready can still be presented.
      return;
    }
    if (mine !== reads.current) return;
    if (next.steps.length === 0) { exit('La escena que presentabas se quedó sin pasos.'); return; }
    const nextSignature = deckSignature(next);
    if (nextSignature === signature.current) return;
    signature.current = nextSignature;
    setDeck(next);
  }, [api, projectId, sceneId, exit]);
  useEffect(() => { void read(); return () => { reads.current++; }; }, [read]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeEvents((event) => {
      const here = event.projectId === projectId && ((event.kind === 'step' && event.sceneId === sceneId) || (event.kind === 'scene' && event.id === sceneId));
      if (!here && event.type !== 'ready') return;
      clearTimeout(timer);
      timer = setTimeout(() => void read(), RELOAD_DELAY_MS);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [subscribeEvents, projectId, sceneId, read]);

  // Which page should be on screen, and getting the neighbours ready. A layout effect, so a page already prepared
  // reaches the screen in the same frame as the key press.
  const viewed = useRef<string>(undefined);
  const wanted = useRef<string>(undefined);
  const shownNow = useRef<Shown>(undefined);
  useLayoutEffect(() => {
    if (!deck || !step) return;
    const identity = `${step.id}/${theme}`;
    const key = pageKey(deck, step, theme);
    if (viewed.current !== identity) { viewed.current = identity; wanted.current = key; queue.retry(key); }
    else if (shownNow.current?.identity !== identity) wanted.current = key;  // Not on screen yet: follow the newest version.
    const result = queue.peek(wanted.current!);
    if (result && shownNow.current?.result !== result) {
      const before = shownNow.current;
      shownNow.current = { identity, result, previous: before?.result.page ?? before?.previous };
      setShown(shownNow.current);
    }
    const jobs = preparationOrder(index, deck.steps.length).map((position) => {
      const neighbour = deck.steps[position];
      return { key: pageKey(deck, neighbour, theme), run: () => renderPage(api, projectId, deck, neighbour, theme) };
    });
    const onScreen = [shownNow.current?.result.page?.key, shownNow.current?.previous?.key].filter((value): value is string => value !== undefined);
    queue.want(jobs, onScreen);
  }, [api, projectId, deck, step, index, theme, queue, progress]);

  const act = useCallback((action: PresentAction) => {
    if (action === 'exit') { exit(); return; }
    if (!deck) return;
    setCurrentId(deck.steps[moveIndex(action, index, deck.steps.length)].id);
  }, [deck, index, exit]);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      // Nothing here takes focus, and it must not wander to the app underneath.
      if (event.key === 'Tab') { event.preventDefault(); return; }
      const action = keyAction(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      act(action);
    };
    window.addEventListener('keydown', press, true);
    return () => window.removeEventListener('keydown', press, true);
  }, [act]);

  // Current on top, then the one it fades over, then the neighbours waiting underneath, already painted.
  const current = shown?.result.page;
  const pages = new Map<string, { page: Page; state: 'current' | 'previous' | 'ready' }>();
  if (deck) for (const position of preparationOrder(index, deck.steps.length)) {
    const page = queue.peek(pageKey(deck, deck.steps[position], theme))?.page;
    if (page) pages.set(page.key, { page, state: 'ready' });
  }
  if (shown?.previous) pages.set(shown.previous.key, { page: shown.previous, state: 'previous' });
  if (current) pages.set(current.key, { page: current, state: 'current' });

  const frameOf = (page: Page) => anchorRect(page.anchor, presentationFrame(page.content, viewport));
  const count = deck?.steps.length ?? 0;
  return <div
    ref={root} className="present" role="dialog" aria-modal="true" aria-label="Presentación" tabIndex={-1} data-idle={idle}
    onClick={(event) => act(clickAction(event.clientX, window.innerWidth))}
  >
    {[...pages.values()].map(({ page, state }) => <div key={page.key} className="present__page" data-state={state} data-step-id={page.stepId}>
      <div className="present__paper" style={{ background: page.paper }} />
      <img src={page.url} alt="" draggable={false} style={frameOf(page)} />
    </div>)}
    {shown?.result.failed && <div className="present__page" data-state="current"><p className="present__message" role="alert">No se pudo dibujar este paso.</p></div>}
    {/* A minimal frame: the mark and the way out on top, the step and where you are below. It fades with the pointer. */}
    <div className="present__bar present__bar--top">
      <Brand />
      <button type="button" className="present__exit" tabIndex={-1} onClick={(event) => { event.stopPropagation(); exit(); }}>
        <X className="i" aria-hidden="true" />Salir<kbd>Esc</kbd>
      </button>
    </div>
    <div className="present__bar present__bar--bottom">
      <p className="present__title">{step?.document.title}</p>
      <p className="present__hint" aria-hidden="true">← → para navegar</p>
    </div>
    {count > 0 && <div className="indicator" role="status" aria-label={`Paso ${index + 1} de ${count}`}>
      {count <= MAX_TICKS && <span className="indicator__ticks" aria-hidden="true">{deck!.steps.map((item, position) => <i key={item.id} className={position === index ? 'on' : undefined} />)}</span>}
      <span aria-hidden="true">{pad(index + 1)} / {pad(count)}</span>
    </div>}
  </div>;
}
