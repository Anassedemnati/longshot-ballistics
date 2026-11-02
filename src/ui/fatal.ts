/**
 * The error panel: what the player sees when the game cannot start or stops mid-mission. It covers the
 * page, says what went wrong and offers a link back to the menu so nobody is stuck on a dead screen.
 * All DOM; styled in index.html. Safe to call twice (the old panel is replaced).
 */
export function showFatalError(message: string): void {
  // Free the mouse (a locked pointer cannot click the link) and drop the "Preparing mission…" text.
  if (document.pointerLockElement) document.exitPointerLock();
  document.querySelectorAll('.prep, .fatal').forEach((node) => node.remove());

  const root = document.createElement('div');
  root.className = 'fatal';
  // The game's document-level handlers would grab the pointer again on this press.
  root.addEventListener('mousedown', (e) => e.stopPropagation());

  const text = document.createElement('p');
  text.className = 'fatal-text';
  text.textContent = message;
  root.appendChild(text);

  const link = document.createElement('a');
  link.className = 'fatal-link';
  link.href = import.meta.env.BASE_URL;
  link.textContent = 'Back to menu';
  root.appendChild(link);

  document.body.appendChild(root);
}
