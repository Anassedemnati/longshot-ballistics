import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Camera-local exterior model, inspired by references/rifle-concept.png. */
export class FirstPersonRifle {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 10);
  readonly model = new THREE.Group();
  private kick = 0;
  private flashTime = 0;
  private flashPending = false;
  private readonly flash = new THREE.Group();
  private readonly flashLight = new THREE.PointLight(0xffa344, 0, 2, 2);
  private readonly flashMaterial: THREE.SpriteMaterial;

  private reloadTime = 0;
  private time = 0;
  constructor(id: '308' | '338', private readonly suppressed = false) {
    const metal = new THREE.MeshStandardMaterial({ color: 0x30343a, metalness: 0.35, roughness: 0.32 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x62666a, metalness: 0.4, roughness: 0.42 });
    const stock = new THREE.MeshStandardMaterial({ color: id === '308' ? 0x62654a : 0xb39a72, metalness: 0.12, roughness: 0.8 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x161b1c, roughness: 0.95 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x214b59, metalness: 0.65, roughness: 0.08, clearcoat: 1 });
    const box = (w: number,h: number,d: number,x: number,y: number,z: number,mat: THREE.Material) => {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(w,h,d,2,Math.min(w,h,d)*0.15),mat);
      mesh.position.set(x,y,z); this.model.add(mesh); return mesh;
    };
    const tube = (r: number,r2: number,length: number,x: number,y: number,z: number,mat: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r,r2,length,32),mat);
      mesh.rotation.x = Math.PI/2; mesh.position.set(x,y,z); this.model.add(mesh); return mesh;
    };
    // Butt, cheek rest, receiver and tapered fore-end.
    box(.105,.16,.27,0,-.05,.2,stock);
    box(.11,.175,.035,0,-.055,.35,rubber);
    box(.105,.055,.18,0,.055,.19,rubber);
    box(.08,.105,.26,0,0,-.06,stock);
    tube(.039,.039,.25,0,.055,-.065,metal);
    box(.075,.075,.34,0,-.005,-.34,stock);
    const grip = box(.065,.15,.085,0,-.12,.02,rubber); grip.rotation.x = -.25;
    box(.065,.135,.095,0,-.12,-.14,metal);
    box(.065,.014,.12,0,-.13,-.035,metal);
    box(.012,.085,.013,.025,-.08,-.085,metal);
    box(.009,.05,.012,0,-.06,-.035,edge).rotation.x = .3;
    const barrelLength = id === '338' ? .47 : .36;
    tube(.015,.021,barrelLength,0,.04,-.5-barrelLength/2,metal);
    tube(.024,.024,.065,0,.04,-.51-barrelLength,metal);
    tube(.013,.013,.001,0,.04,-.544-barrelLength,rubber);
    if (suppressed) {
      tube(.032,.032,.19,0,.04,-.62-barrelLength,metal);
      tube(.016,.016,.002,0,.04,-.716-barrelLength,rubber);
    }
    // Soft additive flame, attached to the muzzle so it follows recoil.
    const size = 64;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = (x + .5 - size / 2) / (size / 2);
      const dy = (y + .5 - size / 2) / (size / 2);
      const angle = Math.atan2(dy, dx);
      const radius = Math.hypot(dx, dy);
      const edge = .7 + .16 * Math.cos(angle * 5);
      const alpha = Math.pow(Math.max(0, 1 - radius / edge), 1.5);
      const i = (y * size + x) * 4;
      pixels[i] = 255;
      pixels[i + 1] = Math.round(110 + 145 * alpha);
      pixels[i + 2] = Math.round(20 + 220 * alpha * alpha);
      pixels[i + 3] = Math.round(255 * alpha);
    }
    const texture = new THREE.DataTexture(pixels, size, size);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.flashMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const flame = new THREE.Sprite(this.flashMaterial);
    flame.scale.set(.23, .23, 1);
    this.flash.add(flame);
    const core = new THREE.Sprite(this.flashMaterial);
    core.position.z = -.07;
    core.scale.set(.12, .12, 1);
    this.flash.add(core);
    this.flash.position.set(0, .04, (suppressed ? -.74 : -.57) - barrelLength);
    this.flashLight.position.set(0, .09, -.49 - barrelLength);
    this.flash.visible = false;
    this.model.add(this.flash, this.flashLight);
    // Rail teeth, handguard recesses and magazine fluting.
    box(.055,.016,.44,0,.09,-.19,metal);
    for(let i=0;i<24;i++) box(.062,.009,.008,0,.102,-.395+i*.018,edge);
    for(let i=0;i<7;i++) {
      for(const side of [-1,1]) box(.003,.018,.028,side*.038,.005,-.23-i*.038,rubber);
    }
    for(let i=0;i<4;i++) for(const side of [-1,1]) box(.003,.095,.006,side*.033,-.13,-.17+i*.02,edge);
    // Scope mounts, main tube, eyepiece, objective bell and coated lenses.
    for(const z of [-.04,-.23]) {
      box(.07,.04,.035,0,.125,z,metal);
      tube(.036,.036,.028,0,.17,z,edge);
    }
    tube(.028,.028,.32,0,.17,-.14,metal);
    tube(.041,.041,.085,0,.17,.045,metal);
    tube(.045,.029,.11,0,.17,-.35,metal);
    tube(.046,.046,.035,0,.17,-.42,metal);
    tube(.035,.035,.002,0,.17,.089,glass);
    tube(.04,.04,.002,0,.17,-.439,glass);
    for(const z of [.012,.078,-.407]) tube(.043,.043,.008,0,.17,z,edge);
    const turret = tube(.024,.024,.04,0,.215,-.12,metal); turret.rotation.x = 0;
    const sideTurret = tube(.022,.022,.035,.04,.17,-.12,metal); sideTurret.rotation.z = Math.PI/2;
    for(let i=0;i<24;i++) {
      const a = i*Math.PI/12;
      box(.004,.027,.004,Math.cos(a)*.024,.22,-.12+Math.sin(a)*.024,edge);
    }
    const bolt = tube(.008,.008,.07,.06,.04,.02,edge); bolt.rotation.z = 1;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(.018,20,12),metal);
    knob.position.set(.088,.018,.02); this.model.add(knob);
    for(const z of [-.25,-.12,.1]) for(const side of [-1,1]) {
      const screw = tube(.006,.006,.003,side*.052,.015,z,edge); screw.rotation.z = Math.PI/2;
    }
    this.model.rotation.y = -.09;
    this.scene.add(this.model);
    this.scene.add(new THREE.HemisphereLight(0xdcecff,0x8d7654,3));
    const key = new THREE.DirectionalLight(0xffdfad,4); key.position.set(-3,4,2); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc5e0ff,2); fill.position.set(3,1,-2); this.scene.add(fill);
  }
  fire(): void {
    this.kick = 1;
    this.flashTime = .085;
    this.flashPending = true;
    this.flashMaterial.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(.85 + Math.random() * .3);
  }
  reload(): void { this.reloadTime = 2.8; }
  update(dt: number): void {
    this.time += dt;
    // Keep the first flash frame even when a slow frame exceeds its lifetime.
    if (!this.flashPending) this.flashTime = Math.max(0, this.flashTime - dt);
    this.flashPending = false;
    this.flash.visible = this.flashTime > 0;
    const brightness = this.flashTime / .085;
    this.flashMaterial.opacity = brightness * (this.suppressed ? .12 : 1);
    this.flashLight.intensity = brightness * (this.suppressed ? .15 : 3);

    this.kick *= Math.exp(-dt*13);
    this.reloadTime = Math.max(0,this.reloadTime-dt);
    const dip = this.reloadTime > 0 ? Math.sin(Math.PI*(1-this.reloadTime/2.8)) : 0;
    this.model.position.set(.21+Math.sin(this.time*1.2)*.002,-.24-dip*.18,-.49+this.kick*.065);
    this.model.rotation.x = this.kick*.09-dip*.3;
    this.model.rotation.z = -.025+dip*.25;
  }
  render(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getSize(new THREE.Vector2());
    this.camera.aspect = size.x/size.y; this.camera.updateProjectionMatrix();
    const auto = renderer.autoClear; renderer.autoClear = false;
    renderer.clearDepth(); renderer.render(this.scene,this.camera); renderer.autoClear = auto;
  }
}
