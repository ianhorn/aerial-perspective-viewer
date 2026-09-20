// Decides when the "rendering" indicator is shown. Work that finishes quickly (a pan over photos already read)
// should not flash a spinner, and one that has appeared should not vanish a moment later, so the indicator
//   - appears only once the work has been going for `showAfterMs`, unless the work is `immediate` (something the user
//     just asked for, which is known to take a while), when it appears at once, and
//   - once shown, stays for at least `minShownMs`.
// It holds no DOM and no clock of its own, so it can be tested with fake timers.

export interface BusyGateOptions {
  /** How long the work must go on before the indicator is shown. */
  showAfterMs: number;
  /** How long a shown indicator stays, at least. */
  minShownMs: number;
  /** A clock in milliseconds, for tests. */
  now?: () => number;
}

export interface BusyGate {
  /**
   * Say whether work is going on now. Saying the same thing again changes nothing (in particular, it does not restart
   * the wait). `immediate` skips the wait: the indicator shows at once, also when the work was already going on and
   * only now turns out to be something the user asked for.
   */
  set(busy: boolean, immediate?: boolean): void;
  /** Whether the indicator is showing. */
  readonly shown: boolean;
  /** Stop for good: no timer is left running and `onChange` is not called again. */
  dispose(): void;
}

export function createBusyGate(options: BusyGateOptions, onChange: (shown: boolean) => void): BusyGate {
  const now = options.now ?? ((): number => performance.now());
  let busy = false;
  let shown = false;
  let shownAt = 0;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const show = (): void => {
    showTimer = undefined;
    if (disposed || !busy || shown) return;
    shown = true;
    shownAt = now();
    onChange(true);
  };
  const hide = (): void => {
    hideTimer = undefined;
    if (disposed || busy || !shown) return;
    shown = false;
    onChange(false);
  };

  const showNow = (): void => {
    clearTimeout(showTimer);
    show();
  };

  return {
    set(next: boolean, immediate = false): void {
      if (disposed) return;
      if (next === busy) {
        if (busy && immediate && !shown) showNow();
        return;
      }
      busy = next;
      if (busy) {
        clearTimeout(hideTimer); // it came back while the indicator was waiting out its minimum: it just stays
        hideTimer = undefined;
        if (immediate) showNow();
        else if (!shown && showTimer === undefined) showTimer = setTimeout(show, options.showAfterMs);
      } else {
        clearTimeout(showTimer); // finished before it was ever shown
        showTimer = undefined;
        if (shown) {
          const left = options.minShownMs - (now() - shownAt);
          if (left <= 0) hide();
          else hideTimer = setTimeout(hide, left);
        }
      }
    },
    get shown(): boolean {
      return shown;
    },
    dispose(): void {
      disposed = true;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    },
  };
}
