/** Pitch limit, rad (80 degrees). */
export const PITCH_LIMIT = (80 * Math.PI) / 180;

/** Minimum time between zoom steps from the wheel, ms. */
const WHEEL_MIN_INTERVAL_MS = 80;

export type MouseAction = 'fire' | 'toggleScope' | 'requestLock';

/**
 * Pure input state machine: pointer-lock state, look angles and what a click means. DOM events are
 * wired to it in `bindInput`. Conventions: yaw about +Y (positive turns left), pitch positive looks up.
 */
export class InputState {
  locked = false;
  yaw = 0;
  pitch = 0;

  onLockChange(locked: boolean): void {
    this.locked = locked;
  }

  /**
   * Meaning of a mouse button press. While the pointer is free, the left button asks for the lock
   * (that click does not fire); once locked, left fires and right toggles the scope.
   */
  onMouseDown(button: number): MouseAction | null {
    if (!this.locked) return button === 0 ? 'requestLock' : null;
    if (button === 0) return 'fire';
    if (button === 2) return 'toggleScope';
    return null;
  }

  /** Look around by a mouse delta in px; `sensitivity` is rad per px. Ignored while unlocked. */
  onMouseMove(dx: number, dy: number, sensitivity: number): void {
    if (!this.locked) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(sensitivity)) return;
    this.yaw -= dx * sensitivity;
    this.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, this.pitch - dy * sensitivity));
  }
}

export interface InputHandlers {
  fire(): void;
  toggleScope(): void;
  reload(): void;
  /** Mouse wheel; `notches` is +1 per notch toward the user (zoom out), -1 away (zoom in). */
  wheel(notches: number): void;
  /** Look sensitivity right now, rad per px (depends on the zoom). */
  sensitivity(): number;
}

/**
 * Wire DOM events to an InputState. Returns a function that removes the listeners.
 * Left click on the canvas asks for pointer lock; everything else works only while locked.
 */
export function bindInput(
  canvas: HTMLElement,
  state: InputState,
  handlers: InputHandlers,
  onLockChange?: (locked: boolean) => void,
): () => void {
  const listeners: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
    target: Document | HTMLElement = document,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, fn as EventListener, options);
    listeners.push(() => target.removeEventListener(type, fn as EventListener, options));
  };

  on('mousedown', (e) => {
    const action = state.onMouseDown(e.button);
    if (action === 'requestLock') {
      // A refused request (Chrome blocks re-locking for ~1 s after Esc) leaves us unlocked; the
      // next click simply tries again.
      Promise.resolve(canvas.requestPointerLock() as unknown).catch(() => undefined);
    } else if (action === 'fire') handlers.fire();
    else if (action === 'toggleScope') handlers.toggleScope();
  });
  on('mousemove', (e) => state.onMouseMove(e.movementX, e.movementY, handlers.sensitivity()));
  on('contextmenu', (e) => e.preventDefault());
  on('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    state.onLockChange(locked);
    onLockChange?.(locked);
  });
  on('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat) handlers.reload();
  });
  // One zoom step per notch. Trackpads fire a stream of tiny wheel events, so steps are rate limited.
  let lastNotchMs = -Infinity;
  on(
    'wheel',
    (e) => {
      if (!state.locked || e.deltaY === 0) return;
      e.preventDefault();
      if (e.timeStamp - lastNotchMs < WHEEL_MIN_INTERVAL_MS) return;
      lastNotchMs = e.timeStamp;
      handlers.wheel(Math.sign(e.deltaY));
    },
    canvas,
    { passive: false },
  );
  return () => listeners.forEach((off) => off());
}
