import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { ApiClient } from '../lib/api';
import { Brand } from '../components/Brand';
import { pad } from '../components/StepFrame';
import { ApiRequestError } from '../lib/api';
import type { ServiceEvent } from '../state/projects-store';
import { useTheme } from '../editor/use-theme';
import { anchorRect, cameraZoom, NO_ZOOM, presentationFrame, type Viewport, type Zoom } from './framing';
import { VIEW_ZOOM_STEP, zoomViewAt } from './camera-gestures';
import { useCameraGestures } from './use-camera-gestures';
import type { PresentFullscreen } from './fullscreen';
import { keyAction, moveIndex, preparationOrder, viewKeyAction, type PresentAction, type ViewAction } from './navigation';
import { Laser } from './Laser';
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
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), delay);
    };
    const move = (event: MouseEvent) => {
      if (last?.x === event.clientX && last.y === event.clientY) return;
      last = { x: event.clientX, y: event.clientY };
      wake();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('wheel', wake, { passive: true });
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('wheel', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
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
  // Manual camera changes stay between steps without a saved camera.
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const pointer = useRef<{ x: number; y: number }>(undefined);
  useEffect(() => {
    const move = (event: PointerEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);

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
  // A step with a camera zooms to it, gliding from wherever the previous step was. Leaving one goes back to the whole
  // scene. Between steps without a camera, a zoom made with the keys stays. The first view starts in place.
  const frame = useMemo(() => presentationFrame(deck?.content ?? null, viewport), [deck?.content, viewport]);
  const stepCamera = step?.document.camera;
  const cameraSignature = stepCamera ? JSON.stringify(stepCamera) : '';
  const [motion, setMotion] = useState<'none' | 'zoom' | 'camera'>('none');
  const directMotion = useCallback(() => setMotion('none'), []);
  const { panReady, panning } = useCameraGestures(root, zoom, setZoom, directMotion);
  // The laser shows only while the pointer is held down on the drawing. A press never changes the step: the pager's
  // arrows and the keys do. Space + drag and the middle button pan instead.
  const [laser, setLaser] = useState<number>();
  const holdLaser = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || panReady || (event.target instanceof Element && event.target.closest('button, .indicator, .present__bar'))) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* it still follows the pointer over the page */ }
    setLaser(event.pointerId);
  };
  const dropLaser = (event: React.PointerEvent<HTMLDivElement>) => { if (event.pointerId === laser) setLaser(undefined); };
  useEffect(() => {
    if (laser === undefined) return;
    const off = () => setLaser(undefined);
    window.addEventListener('blur', off);
    return () => window.removeEventListener('blur', off);
  }, [laser]);
  const home = useRef<Zoom>(NO_ZOOM);
  const last = useRef<{ stepId?: string; camera: string; frame?: typeof frame }>({ camera: '' });
  useEffect(() => {
    if (!stepId) return;
    const before = last.current;
    last.current = { stepId, camera: cameraSignature, frame };
    home.current = stepCamera ? cameraZoom(stepCamera, frame, viewport) : NO_ZOOM;
    const resized = before.frame !== undefined && before.frame !== frame;
    if (!stepCamera && !before.camera && !resized) return;
    setMotion(before.stepId === undefined || (resized && before.stepId === stepId) ? 'none' : 'camera');
    setZoom(home.current);
    // stepCamera is read through its signature, so a new object with the same box does not move the view.
  }, [stepId, cameraSignature, frame, viewport]);
  const view = useCallback((action: ViewAction) => {
    if (action === 'zoomReset') { setMotion('zoom'); setZoom(home.current); return; }
    const size = viewportNow();
    const around = pointer.current ?? { x: size.width / 2, y: size.height / 2 };
    setMotion('zoom');
    setZoom((current) => zoomViewAt(current, current.scale + (action === 'zoomIn' ? VIEW_ZOOM_STEP : -VIEW_ZOOM_STEP), around));
  }, []);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      // Nothing here takes focus, and it must not wander to the app underneath.
      if (event.key === 'Tab') { event.preventDefault(); return; }
      const looking = viewKeyAction(event);
      if (looking) { event.preventDefault(); event.stopPropagation(); view(looking); return; }
      const action = keyAction(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      act(action);
    };
    window.addEventListener('keydown', press, true);
    return () => window.removeEventListener('keydown', press, true);
  }, [act, view]);

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
  const control = (action: PresentAction) => () => act(action);
  const zoomed = zoom.scale !== 1 || zoom.x !== 0 || zoom.y !== 0;
  return <div
    ref={root} className="present" role="dialog" aria-modal="true" aria-label="Presentación" tabIndex={-1} data-idle={idle && !panReady && !panning} data-laser={laser !== undefined || undefined} data-pan-ready={panReady || undefined} data-panning={panning || undefined}
    onPointerDown={holdLaser} onPointerUp={dropLaser} onPointerCancel={dropLaser} onLostPointerCapture={dropLaser}
  >
    <div className="present__paper" style={{ background: current?.paper }} />
    {/* The zoom magnifies the pages only: the frame and the pager stay as they are. */}
    <div className="present__stage" data-zoomed={zoomed || undefined} data-motion={motion} style={zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined}>
      {[...pages.values()].map(({ page, state }) => <div key={page.key} className="present__page" data-state={state} data-step-id={page.stepId}>
        <div className="present__paper" style={{ background: page.paper }} />
        <img src={page.url} alt="" draggable={false} style={frameOf(page)} />
      </div>)}
      {shown?.result.failed && <div className="present__page" data-state="current"><p className="present__message" role="alert">No se pudo dibujar este paso.</p></div>}
    </div>
    {laser !== undefined && <Laser start={pointer.current} />}
    {/* A minimal frame: the mark and the way out on top, the step and where you are below. It fades with the pointer. */}
    <div className="present__bar present__bar--top">
      <Brand />
      <button type="button" className="present__exit" tabIndex={-1} onClick={() => exit()}>
        <X className="i" aria-hidden="true" />Salir<kbd>Esc</kbd>
      </button>
    </div>
    <div className="present__bar present__bar--bottom">
      <p className="present__title">{step?.document.title}</p>
      <p className="present__hint" aria-hidden="true" title="Pellizca o usa Ctrl/Cmd + rueda para zoom. Desplaza con dos dedos, la rueda o Espacio + arrastrar.">← → pasos · mantén pulsado: láser · + − zoom{zoomed && zoom !== home.current ? ` · ${Math.round(zoom.scale * 100)}%, 0 vuelve` : ''}</p>
    </div>
    {count > 0 && <div className="indicator">
      <button type="button" className="indicator__btn" tabIndex={-1} aria-label="Primer paso" title="Primer paso (Inicio)" disabled={index === 0} onClick={control('first')}><ChevronFirst className="i" aria-hidden="true" /></button>
      <button type="button" className="indicator__btn" tabIndex={-1} aria-label="Paso anterior" title="Paso anterior (←)" disabled={index === 0} onClick={control('previous')}><ChevronLeft className="i" aria-hidden="true" /></button>
      <span className="indicator__where" role="status" aria-label={`Paso ${index + 1} de ${count}`}>
        {count <= MAX_TICKS && <span className="indicator__ticks" aria-hidden="true">{deck!.steps.map((item, position) => <i key={item.id} className={position === index ? 'on' : undefined} />)}</span>}
        <span aria-hidden="true">{pad(index + 1)} / {pad(count)}</span>
      </span>
      <button type="button" className="indicator__btn" tabIndex={-1} aria-label="Paso siguiente" title="Paso siguiente (→)" disabled={index === count - 1} onClick={control('next')}><ChevronRight className="i" aria-hidden="true" /></button>
      <button type="button" className="indicator__btn" tabIndex={-1} aria-label="Último paso" title="Último paso (Fin)" disabled={index === count - 1} onClick={control('last')}><ChevronLast className="i" aria-hidden="true" /></button>
    </div>}
  </div>;
}
