/** Deliberately readable game AI: exposure, telegraphed attacks, and cover. */
export class Encounter {
  health = 100;
  detection = 0;
  sniperClock = 0;
  mortarClock = 0;
  warning = 0;
  ended = false;
  shot(suppressed: boolean): void { this.detection = Math.min(100, this.detection + (suppressed ? 9 : 35)); }
  update(dt: number, alive: number, covered: boolean): 'shot' | 'blast' | null {
    if (this.ended) return null;
    if (alive === 0 || this.health <= 0) { this.ended = true; return null; }
    this.detection = Math.max(0, Math.min(100, this.detection + dt * (covered ? -9 : 4)));
    if (this.warning > 0) {
      this.warning = Math.max(0, this.warning - dt);
      if (this.warning === 0) { this.health = Math.max(0,this.health-(covered ? 5 : 45)); return 'blast'; }
    }
    if (this.detection < 65) return null;
    this.sniperClock += dt;
    this.mortarClock += dt;
    if (this.mortarClock >= 12) { this.mortarClock = 0; this.warning = 4; }
    if (this.sniperClock >= 4) {
      this.sniperClock = 0;
      if (!covered) this.health = Math.max(0,this.health-18);
      return 'shot';
    }
    return null;
  }
}
