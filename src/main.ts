import { routeFromSearch } from './mission/config';
import { runMission } from './mission/run';
import { showFatalError } from './ui/fatal';
import { showMenu } from './ui/menu';

async function start(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  const route = routeFromSearch(window.location.search);
  if (route.kind === 'menu') {
    // `?debug=1` on the menu exposes window.__menu and is carried into the mission the menu starts.
    const debug = new URLSearchParams(window.location.search).get('debug') === '1';
    showMenu(app, { last: route.last, debug });
    return;
  }
  await runMission(route.config, { legacy: route.legacy, debug: route.debug });
}

// A failed start (no WebGL, a layout that cannot be built, ...) gets a message and a way back to the menu.
start().catch((error: unknown) => {
  console.error(error);
  showFatalError('Could not start the game: ' + (error instanceof Error ? error.message : String(error)));
});
