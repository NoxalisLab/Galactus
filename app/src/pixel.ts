// Galactus — visualisation "agents au travail" en pixel-art.
// Sprite 16x16 dessine par code, echelle x3, boucle ~12 fps.
// Zero dependance, TypeScript strict, canvas HTML5 uniquement.

export type PixelMode =
  | "idle"
  | "thinking"
  | "reading"
  | "writing"
  | "running"
  | "connector"
  | "done";

const SCALE = 3;
const GRID = 16; // sprite 16x16
const CANVAS_H = GRID * SCALE; // 48px
const STEP_MS = 1000 / 12; // ~12 fps assumes

// Palette (cf. src/styles.css : --acc / --acc2)
const ACC = "#8a7cff";
const ACC2 = "#b06cff";
const WHITE = "#ffffff";
const LABEL_COLOR = "#7c7c8c";

interface Particle {
  x: number; // en unites de grille (pixels logiques)
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
}

export class PixelViz {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private destroyed = false;

  private mode: PixelMode = "idle";
  private label = "";

  private frame = 0; // frame globale (12 fps)
  private modeFrame = 0; // frames depuis le dernier setMode
  private lastTime = 0;
  private accMs = 0;

  private confetti: Particle[] = [];
  private sparks: Particle[] = [];
  private resizeObs: ResizeObserver | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    const canvas = document.createElement("canvas");
    canvas.height = CANVAS_H;
    canvas.width = Math.max(container.clientWidth, GRID * SCALE + 8);
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = `${CANVAS_H}px`;
    canvas.style.imageRendering = "pixelated";
    this.canvas = canvas;

    // Get the context BEFORE inserting: a throw here must not leave an
    // orphan canvas in the DOM that no instance can ever remove.
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("PixelViz: canvas 2d context unavailable");
    }
    container.appendChild(canvas);
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.syncSize());
      this.resizeObs.observe(container);
    }

    this.raf = requestAnimationFrame(this.tick);
  }

  setMode(mode: PixelMode, label?: string): void {
    if (this.destroyed) return;
    if (mode !== this.mode) {
      this.mode = mode;
      this.modeFrame = 0;
      if (mode === "done") this.spawnConfetti();
      if (mode !== "writing") this.sparks.length = 0;
    }
    this.label = label ?? "";
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs = null;
    }
    if (this.canvas.parentNode === this.container) {
      this.container.removeChild(this.canvas);
    }
  }

  // ------------------------------------------------------------------ boucle

  private tick = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.tick);

    if (this.lastTime === 0) this.lastTime = now;
    this.accMs += now - this.lastTime;
    this.lastTime = now;

    let stepped = false;
    // Cadence ~12 fps ; on borne le rattrapage pour eviter les rafales.
    if (this.accMs > STEP_MS * 6) this.accMs = STEP_MS * 6;
    while (this.accMs >= STEP_MS) {
      this.accMs -= STEP_MS;
      this.step();
      stepped = true;
    }
    if (stepped) this.render();
  };

  private step(): void {
    this.frame++;
    this.modeFrame++;

    // "done" : confetti bref puis retour idle automatique.
    if (this.mode === "done" && this.modeFrame > 26 && this.confetti.length === 0) {
      this.mode = "idle";
      this.modeFrame = 0;
    }

    // Physique confetti (unites de grille).
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const p = this.confetti[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.22; // gravite
      p.life--;
      if (p.life <= 0 || p.y > GRID + 1) this.confetti.splice(i, 1);
    }

    // Etincelles de frappe.
    if (this.mode === "writing" && this.frame % 2 === 0) {
      const side = this.frame % 4 === 0 ? 3 : 12;
      this.sparks.push({
        x: side + (Math.random() * 2 - 1),
        y: 10 + Math.random(),
        vx: (Math.random() - 0.5) * 0.8,
        vy: -0.5 - Math.random() * 0.5,
        color: Math.random() < 0.5 ? WHITE : ACC2,
        life: 3,
      });
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.life--;
      if (s.life <= 0) this.sparks.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ rendu

  private syncSize(): void {
    const w = Math.max(this.container.clientWidth, GRID * SCALE + 8);
    if (w !== this.canvas.width) {
      this.canvas.width = w;
      this.ctx.imageSmoothingEnabled = false;
      this.render();
    }
  }

  /** Dessine un pixel logique (aligne sur la grille x3). */
  private px(x: number, y: number, color: string, alpha = 1): void {
    if (alpha <= 0) return;
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.fillRect(Math.round(x) * SCALE, Math.round(y) * SCALE, SCALE, SCALE);
    c.globalAlpha = 1;
  }

  private render(): void {
    const c = this.ctx;
    const f = this.frame;
    const mf = this.modeFrame;
    const mode = this.mode;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // ---- fond "running" : terminal / courbe qui defile derriere le robot
    if (mode === "running") {
      for (let i = 0; i < GRID; i++) {
        const t = i + Math.floor(f / 1);
        const h = 2 + Math.round(2.5 + 2.4 * Math.sin(t * 1.7) * Math.sin(t * 0.53));
        for (let y = 0; y < h; y++) {
          this.px(i, GRID - 1 - y, y === h - 1 ? ACC2 : ACC, y === h - 1 ? 0.5 : 0.16);
        }
      }
    }

    // ---- parametres d'animation du robot
    let oy = 0; // respiration (bob vertical)
    let headDx = 0; // balancement de la tete
    let eyeDx = 0; // regard
    let blink = false;
    let mouthWide = false;
    type ArmPose = "down" | "typeL" | "typeR" | "up" | "reach" | "hold";
    let arms: ArmPose = "down";

    switch (mode) {
      case "idle":
        oy = f % 16 < 8 ? 0 : 1;
        blink = f % 46 < 2;
        break;
      case "thinking":
        oy = f % 16 < 8 ? 0 : 1;
        headDx = f % 24 < 12 ? 0 : 1; // leger balancement
        eyeDx = f % 24 < 12 ? -1 : 1; // regarde en l'air, pensif
        break;
      case "reading": {
        arms = "hold";
        const scan = [-1, -1, 0, 1, 1, 0];
        eyeDx = scan[Math.floor(f / 3) % scan.length];
        oy = f % 20 < 10 ? 0 : 1;
        break;
      }
      case "writing":
        arms = f % 2 === 0 ? "typeL" : "typeR";
        oy = f % 4 < 2 ? 0 : 1; // frappe energique
        break;
      case "running":
        oy = f % 6 < 3 ? 0 : 1;
        eyeDx = f % 12 < 6 ? 0 : 1; // suit le graphe
        break;
      case "connector":
        arms = "reach";
        eyeDx = 1; // regarde la prise
        oy = f % 12 < 6 ? 0 : 1;
        break;
      case "done":
        arms = "up";
        mouthWide = true;
        oy = f % 4 < 2 ? 0 : 1; // sautille de joie
        blink = mf % 12 < 3; // yeux plisses de bonheur
        break;
    }

    this.drawRobot(oy, headDx, eyeDx, blink, mouthWide, arms);

    // ---- extras par mode (au-dessus du robot)
    if (mode === "thinking") {
      // Points de suspension au-dessus de la tete, apparition sequentielle.
      const n = Math.floor(f / 4) % 4; // 0..3 points visibles
      const xs = [10, 12, 14];
      const ys = [1, 0, 1]; // le point du milieu flotte un peu plus haut
      for (let i = 0; i < 3; i++) {
        if (i < n) this.px(xs[i], ys[i], i === 2 ? WHITE : ACC, 0.95);
      }
    }

    if (mode === "reading") this.drawPage(oy, f);
    if (mode === "connector") this.drawBolt(f);

    // ---- particules
    for (const p of this.confetti) this.px(p.x, p.y, p.color, Math.min(1, p.life / 4));
    for (const s of this.sparks) this.px(s.x, s.y, s.color, s.life / 3);

    // ---- label a droite du sprite
    if (this.label) {
      c.font = '11px "IBM Plex Mono", ui-monospace, monospace';
      c.fillStyle = LABEL_COLOR;
      c.textBaseline = "middle";
      c.textAlign = "left";
      const maxW = this.canvas.width - (GRID * SCALE + 10) - 4;
      if (maxW > 12) {
        c.fillText(this.ellipsize(this.label, maxW), GRID * SCALE + 10, CANVAS_H / 2 + 1);
      }
    }
  }

  private ellipsize(text: string, maxW: number): string {
    const c = this.ctx;
    if (c.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && c.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  // ------------------------------------------------------------ dessin sprite

  private drawRobot(
    oy: number,
    headDx: number,
    eyeDx: number,
    blink: boolean,
    mouthWide: boolean,
    arms: "down" | "typeL" | "typeR" | "up" | "reach" | "hold",
  ): void {
    const f = this.frame;
    const P = (x: number, y: number, col: string, a = 1): void => this.px(x, y + oy, col, a);

    // Antenne (le corps porte l'antenne ; la tete balance avec headDx)
    P(7 + headDx, 2, ACC2);
    P(7 + headDx, 1, f % 24 < 12 ? WHITE : ACC2, f % 24 < 12 ? 1 : 0.8); // tip clignotant

    // Tete (8x6, coins arrondis) — legerement etoilee par l'antenne
    for (let y = 3; y <= 8; y++) {
      for (let x = 4; x <= 11; x++) {
        const corner = (x === 4 || x === 11) && (y === 3 || y === 8);
        if (!corner) P(x + headDx, y, ACC);
      }
    }
    // Visage : plaque plus claire
    for (let y = 4; y <= 7; y++) {
      for (let x = 5; x <= 10; x++) P(x + headDx, y, WHITE, 0.1);
    }
    // Yeux
    if (blink) {
      P(6 + headDx, 5, ACC2);
      P(9 + headDx, 5, ACC2);
    } else {
      P(6 + eyeDx + headDx, 5, WHITE);
      P(9 + eyeDx + headDx, 5, WHITE);
    }
    // Bouche
    if (mouthWide) {
      P(6 + headDx, 7, WHITE, 0.9);
      P(7 + headDx, 7, WHITE, 0.9);
      P(8 + headDx, 7, WHITE, 0.9);
      P(9 + headDx, 7, WHITE, 0.9);
    } else {
      P(7 + headDx, 7, WHITE, 0.55);
      P(8 + headDx, 7, WHITE, 0.55);
    }

    // Corps (6x4)
    for (let y = 9; y <= 12; y++) {
      for (let x = 5; x <= 10; x++) P(x, y, ACC2);
    }
    // Coeur/voyant de poitrine, pulse doux
    const pulse = f % 12 < 6 ? 0.95 : 0.45;
    P(7, 10, WHITE, pulse);
    P(8, 10, WHITE, pulse);

    // Bras
    switch (arms) {
      case "down":
        P(3, 10, ACC); P(3, 11, ACC);
        P(12, 10, ACC); P(12, 11, ACC);
        break;
      case "typeL": // main gauche frappe (plus basse)
        P(3, 11, ACC); P(3, 12, WHITE, 0.9);
        P(12, 10, ACC); P(12, 11, WHITE, 0.9);
        break;
      case "typeR":
        P(3, 10, ACC); P(3, 11, WHITE, 0.9);
        P(12, 11, ACC); P(12, 12, WHITE, 0.9);
        break;
      case "up": // bras leves, victoire
        P(3, 8, ACC); P(3, 7, ACC); P(3, 6, WHITE, 0.95);
        P(12, 8, ACC); P(12, 7, ACC); P(12, 6, WHITE, 0.95);
        break;
      case "reach": // tend le bras droit vers la prise
        P(3, 10, ACC); P(3, 11, ACC);
        P(12, 9, ACC); P(13, 8, ACC); P(13, 7, WHITE, 0.9);
        break;
      case "hold": // tient la page (mains vers l'avant-gauche)
        P(4, 10, ACC); P(3, 11, ACC);
        P(11, 10, ACC); P(12, 11, ACC);
        break;
    }

    // Jambes + pieds
    P(6, 13, ACC);
    P(9, 13, ACC);
    P(5, 14, ACC2); P(6, 14, ACC2);
    P(9, 14, ACC2); P(10, 14, ACC2);
  }

  /** Page tenue devant le robot (mode reading). */
  private drawPage(oy: number, f: number): void {
    const P = (x: number, y: number, col: string, a = 1): void => this.px(x, y + oy, col, a);
    for (let y = 8; y <= 13; y++) {
      for (let x = 1; x <= 5; x++) P(x, y, WHITE, 0.92);
    }
    P(5, 8, ACC, 0.35); // coin corne
    // Lignes de texte ; celle "en cours de lecture" est accentuee
    const cur = Math.floor(f / 6) % 4;
    for (let i = 0; i < 4; i++) {
      const y = 9 + i;
      const on = i === cur;
      P(2, y, on ? ACC2 : ACC, on ? 0.95 : 0.4);
      P(3, y, on ? ACC2 : ACC, on ? 0.95 : 0.4);
      if (i % 2 === 0) P(4, y, on ? ACC2 : ACC, on ? 0.95 : 0.4);
    }
  }

  /** Prise + eclair (mode connector). */
  private drawBolt(f: number): void {
    const on = f % 6 < 3;
    // Prise murale stylisee a droite
    this.px(15, 5, ACC, 0.8);
    this.px(15, 6, ACC, 0.8);
    this.px(15, 7, ACC, 0.8);
    this.px(14, 6, ACC2, 0.9);
    // Eclair zigzag qui pulse entre la main et la prise
    const boltCol = on ? WHITE : ACC2;
    this.px(14, 3, boltCol, on ? 1 : 0.5);
    this.px(13, 4, boltCol, on ? 1 : 0.5);
    this.px(14, 5, boltCol, on ? 1 : 0.5);
    if (on) this.px(13, 2, ACC2, 0.6);
  }

  private spawnConfetti(): void {
    this.confetti.length = 0;
    const colors = [ACC, ACC2, WHITE];
    for (let i = 0; i < 26; i++) {
      this.confetti.push({
        x: 7.5 + (Math.random() - 0.5) * 6,
        y: 3 + Math.random() * 2,
        vx: (Math.random() - 0.5) * 2.2,
        vy: -1.6 - Math.random() * 1.4,
        color: colors[i % colors.length],
        life: 10 + Math.floor(Math.random() * 8),
      });
    }
  }
}
