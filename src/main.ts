import { routeFromSearch } from './mission/config';
import { runMission } from './mission/run';
import { showMenu } from './ui/menu';

function start(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  const route = routeFromSearch(window.location.search);
  if (route.kind === 'menu') {
    // `?debug=1` on the menu exposes window.__menu and is carried into the mission the menu starts.
    const debug = new URLSearchParams(window.location.search).get('debug') === '1';
    showMenu(app, { last: route.last, debug });
    return;
  }
  runMission(route.config, { legacy: route.legacy, debug: route.debug });
}

try {
  start();
} catch (error) {
  console.error(error);
  const app = document.getElementById('app');
  if (app) app.textContent = 'Could not start the game: ' + (error instanceof Error ? error.message : String(error));
}
