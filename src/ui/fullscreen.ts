// Fullscreen for the whole page (the start menu and the game): one button, the F key in a mission, and the label that follows the state. Safari
// only has the prefixed API (`webkitRequestFullscreen` and friends), so every call goes through the small `FullscreenDoc` shape below, which also
// lets the tests drive it with a fake document. Where the browser has no fullscreen at all, the button is not created.

/** The corner of `document` and `document.documentElement` the fullscreen code touches (standard and WebKit-prefixed names). */
export interface FullscreenDoc {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?(): Promise<void> | void;
  webkitExitFullscreen?(): Promise<void> | void;
  documentElement: {
    requestFullscreen?(): Promise<void> | void;
    webkitRequestFullscreen?(): Promise<void> | void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The label of the fullscreen button for the current state. */
export function fullscreenLabel(on: boolean): string {
  return on ? 'Exit fullscreen' : 'Fullscreen';
}

/** True when the browser lets the page go fullscreen (the standard API or Safari's prefixed one, and not disabled by an embedding frame). */
export function fullscreenAvailable(doc: FullscreenDoc = document): boolean {
  const root = doc.documentElement;
  const hasRequest = typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
  if (!hasRequest) return false;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled;
  return enabled !== false;
}

/** True while the page is fullscreen. */
export function isFullscreen(doc: FullscreenDoc = document): boolean {
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
}

/**
 * Enter fullscreen, or leave it when already in it. A refused request (no user gesture, a policy) is swallowed: the label simply does not
 * change, because it only ever follows the real `fullscreenchange`.
 */
export function toggleFullscreen(doc: FullscreenDoc = document): void {
  if (!fullscreenAvailable(doc)) return;
  const root = doc.documentElement;
  const settle = (result: Promise<void> | void): void => {
    if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(() => undefined);
  };
  try {
    if (isFullscreen(doc)) {
      if (doc.exitFullscreen) settle(doc.exitFullscreen());
      else if (doc.webkitExitFullscreen) settle(doc.webkitExitFullscreen());
    } else if (root.requestFullscreen) settle(root.requestFullscreen());
    else if (root.webkitRequestFullscreen) settle(root.webkitRequestFullscreen());
  } catch {
    // some browsers throw instead of rejecting: nothing to do
  }
}

/** Call `listener` whenever the page enters or leaves fullscreen (both event names). Returns a function that stops listening. */
export function onFullscreenChange(listener: () => void, doc: FullscreenDoc = document): () => void {
  doc.addEventListener('fullscreenchange', listener);
  doc.addEventListener('webkitfullscreenchange', listener);
  return () => {
    doc.removeEventListener('fullscreenchange', listener);
    doc.removeEventListener('webkitfullscreenchange', listener);
  };
}

/**
 * A button that toggles fullscreen and says what it will do ("Fullscreen" / "Exit fullscreen"), appended to `parent`; null (nothing is made)
 * where the browser has no fullscreen. Its mouse press never reaches the game's click-to-aim handler on the document, so pressing it neither
 * fires a shot nor grabs the pointer; the label follows `fullscreenchange`, whoever caused it (the F key, Esc).
 */
export function createFullscreenButton(parent: HTMLElement, className: string): HTMLButtonElement | null {
  if (!fullscreenAvailable()) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  const refresh = (): void => {
    button.textContent = fullscreenLabel(isFullscreen());
  };
  refresh();
  button.addEventListener('mousedown', (e) => e.stopPropagation());
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
    button.blur(); // a later Space or Enter must not toggle it again
  });
  onFullscreenChange(refresh);
  parent.appendChild(button);
  return button;
}
