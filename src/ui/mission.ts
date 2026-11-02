import { POSITIONS } from '../scene/terrainHeight';
import { parseConfig, type StageConfig } from '../game/config';

/** No game input is bound until the player deploys. URL settings prefill the form. */
export function missionSetup(): Promise<StageConfig> {
  const initial = parseConfig(location.search);
  return new Promise(resolve => {
    const root = document.createElement('main');
    root.className = 'mission-screen';
    root.innerHTML = `<section class="mission-card"><small>DESERT RANGE / FIELD OPERATIONS</small>
      <h1>Every shot<br>starts here.</h1><p>Configure your rifle and conditions. Read the wind. Find your mark.</p>
      <form><div class="mission-fields">
      <label>Firing position<select name="position"><option value="valley">Valley floor · 1.5 m</option><option value="ridge">Rocky ridge · 12 m</option><option value="mountain">Mountain overlook · 85 m</option></select></label>
      <label>Mission<select name="theme"><option value="outpost">Desert outpost · enemy snipers</option><option value="convoy">Vehicle checkpoint · enemy snipers</option><option value="training">Training · no incoming fire</option></select></label>
      <label>Muzzle attachment<select name="suppressed"><option value="0">Standard muzzle</option><option value="1">Suppressor · reduced noise / flash</option></select></label>
      <label>Rifle<select name="rifle"><option value="308">.308 · Precision rifle</option><option value="338">.338 · Long-range rifle</option></select></label>
      <label>Horizontal distance · metres<input name="range" type="number" min="100" max="1500" step="1" required></label>
      <label>Crosswind · m/s<input name="wind" type="number" min="-30" max="30" step="0.01" required><span>Positive: from left. Negative: from right.</span></label>
      <label>Atmosphere<select name="air"><option value="desert">Hot desert</option><option value="standard">Standard atmosphere</option></select></label>
      </div><p class="position-brief"></p><button type="submit">DEPLOY TO RANGE <span>→</span></button></form>
      <footer>100–1500 m range · T trajectory · A assisted aim · P spotter<br>C toggle cover · Mouse to aim · Left click fire · Right click scope · R reload</footer></section>
      <aside class="mission-art"><span>PRECISION / PATIENCE / CONTROL</span></aside>`;
    document.body.append(root);
    const form = root.querySelector('form')!;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    field('theme').value = initial.theme ?? 'outpost';
    field('suppressed').value = initial.suppressed ? '1' : '0';
    field('position').value = initial.position ?? 'ridge';
    const describePosition = () => { root.querySelector('.position-brief')!.textContent = POSITIONS[field('position').value as keyof typeof POSITIONS].description; };
    field('position').onchange = describePosition;
    describePosition();
    field('rifle').value = initial.rifle;
    field('range').value = String(initial.range);
    field('wind').value = Math.max(-30, Math.min(30, initial.windFromLeftMps)).toFixed(2);
    field('air').value = initial.air;
    form.onsubmit = e => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const params = new URLSearchParams(location.search);
      for (const name of ['rifle','range','wind','air','position','theme','suppressed']) params.set(name, field(name).value);
      history.replaceState(null, '', `${location.pathname}?${params}`);
      root.remove();
      resolve(parseConfig(params.toString()));
    };
    field('rifle').focus();
  });
}
