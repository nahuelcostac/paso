/** Real fullscreen for a presentation. When the browser refuses it or lacks it, nothing fails: the presentation
 * still fills the window. The whole document goes fullscreen because the request has to happen while the
 * person's click still counts, which can be before the presentation has mounted. */
export class PresentFullscreen {
  private wanted = false;
  enter(target: HTMLElement = document.documentElement) {
    this.wanted = true;
    if (!document.fullscreenEnabled || !target.requestFullscreen) return;
    // The person may have left already by the time the browser answers.
    target.requestFullscreen({ navigationUI: 'hide' }).then(() => { if (!this.wanted) this.release(); }).catch(() => {});
  }
  exit() { this.wanted = false; this.release(); }
  private release() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  /** Calls back when fullscreen ends by anything but `exit`: the browser's own control, or Esc when the browser takes that key for itself. */
  onBrowserExit(listener: () => void) {
    let held = Boolean(document.fullscreenElement);
    const change = () => {
      if (document.fullscreenElement) { held = true; return; }
      if (held && this.wanted) listener();
      held = false;
    };
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }
}
