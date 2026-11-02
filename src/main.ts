import { DEFAULT_MISSION, encodeMission, routeFromSearch } from './mission/config';
import { runMission } from './mission/run';

/**
 * Placeholder start screen until the real mission setup menu replaces it: a link that starts the
 * default mission.
 */
function showMenuPlaceholder(app: HTMLElement): void {
  const box = document.createElement('div');
  box.className = 'menu-placeholder';
  const title = document.createElement('h1');
  title.textContent = 'Mission setup coming soon';
  const start = document.createElement('a');
  start.className = 'menu-placeholder-start';
  start.href = `?m=${encodeMission(DEFAULT_MISSION)}`;
  start.textContent = 'Start default mission';
  box.append(title, start);
  app.appendChild(box);
}

function start(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  const route = routeFromSearch(window.location.search);
  if (route.kind === 'menu') {
    showMenuPlaceholder(app);
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
