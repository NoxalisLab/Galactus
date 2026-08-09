// Galactus, visualisation "agents au travail" en pixel-art.
// Sprite 16x16 dessine par code, echelle x3, boucle ~12 fps.
// Zero dependance, TypeScript strict, canvas HTML5 uniquement.

export type PixelMode =
  | "idle"
  | "thinking"
  | "responding" // redige la reponse : frappe + bulle qui se remplit
  | "reading"   // exploration : saute de planete en planete
  | "doc"       // lecture d'un document : page en main
  | "writing"
  | "running"
  | "connector"
  | "web"       // appel satellite
  | "memory"    // range une etoile dans le coffre a souvenirs
  | "fleet"     // lance la flotte de sous-agents
  | "done";

const SCALE = 3;
const GRID = 16; // sprite 16x16
// Largeur MINIMALE de scene. La scene reelle occupe toute la largeur du
// conteneur : le personnage traverse la fenetre au lieu d'etre confine aux 30
// premiers pixels logiques, et les decors s'etalent avec elle.
const STAGE_MIN = 30;
/**
 * Lignes reservees au-dessus de la scene pour la bulle du personnage.
 *
 * C'est lui qui annonce ce qu'il fait, dans sa propre bulle, plutot qu'un
 * libelle pose a l'autre bout de la fenetre : le regard n'a plus a faire
 * l'aller-retour entre le personnage et le texte qui le decrit.
 */
const BUBBLE_ROWS = 11;
/** Hauteur totale de la scene, en lignes : bulle + sprite. */
const SCENE_ROWS = BUBBLE_ROWS + GRID;
const CANVAS_H = SCENE_ROWS * SCALE;
/** Frames de l'entree : il monte de derriere le fil jusqu'a sa hauteur. */
const ENTER_FRAMES = 10;
/** Frames pendant lesquelles une bulle se gonfle apres un changement. */
const POP_FRAMES = 5;
const STEP_MS = 1000 / 12; // ~12 fps assumes
// Duree minimale d'une scene d'action (~2 s a 12 fps) : les outils locaux
// finissent en millisecondes, sans plancher la scene serait invisible.
const MIN_SCENE_FRAMES = 24;

// Scene "recherche" : les centres des planetes sont calcules a la largeur
// courante (voir planetX), pour que le personnage traverse toute la fenetre.
const HOP_FRAMES = 22; // duree d'un saut de planete a planete

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
  /**
   * Retour a "thinking" mis en attente : un outil local finit souvent en
   * quelques dizaines de millisecondes et la scene d'action serait invisible.
   * Elle est tenue au moins MIN_SCENE_FRAMES avant d'etre remplacee.
   */
  private pending: { mode: PixelMode; label: string } | null = null;

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
    // Le canvas couvre tout le conteneur. Fixer style.height a CANVAS_H
    // ecraserait le rendu : la scene serait dessinee sur toute la hauteur puis
    // compressee dans 48 pixels a l'affichage.
    canvas.height = CANVAS_H;
    canvas.width = Math.max(container.clientWidth, STAGE_MIN * SCALE + 8);
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

  /** Largeur de scene en pixels logiques, suit la fenetre. */
  private stageW(): number {
    return Math.max(STAGE_MIN, Math.floor(this.canvas.width / SCALE));
  }

  /**
   * Trois planetes reparties sur toute la scene. Une marge a droite laisse la
   * place au label, et le personnage fait 16 pixels de large.
   */
  private planetX(): [number, number, number] {
    const w = this.stageW();
    const right = Math.max(STAGE_MIN, w - 26);
    return [4, Math.round((4 + right) / 2), right];
  }

  /**
   * Va-et-vient continu sur toute la largeur, en pixels logiques. Triangle
   * plutot que sinus : la vitesse reste constante, ce qui lit mieux en
   * pixel-art qu'une acceleration aux extremites.
   */
  private strollX(f: number, speed: number): number {
    const span = Math.max(0, this.stageW() - GRID - 20);
    if (span <= 0) return 0;
    const period = (span * 2) / speed;
    const t = (f * speed) % (span * 2);
    void period;
    return Math.round(t <= span ? t : span * 2 - t);
  }

  /** Sens du regard, aligne sur le sens de la marche. */
  private strollForward(f: number, speed: number): number {
    const span = Math.max(1, this.stageW() - GRID - 20);
    return ((f * speed) % (span * 2)) <= span ? 1 : -1;
  }

  setMode(mode: PixelMode, label?: string): void {
    if (this.destroyed) return;
    if (mode === this.mode) {
      this.pending = null;
      this.label = label ?? "";
      return;
    }
    // Une scene d'action fraiche n'est pas ecrasee par le "thinking" ou le
    // "responding" de l'iteration suivante : elle reste visible
    // MIN_SCENE_FRAMES, puis le retour attendu s'applique. Une autre action
    // ou "done" passe direct.
    const calm = mode === "thinking" || mode === "responding";
    const inAction =
      this.mode !== "idle" && this.mode !== "thinking" && this.mode !== "responding" && this.mode !== "done";
    if (calm && inAction && this.modeFrame < MIN_SCENE_FRAMES) {
      this.pending = { mode, label: label ?? "" };
      return;
    }
    this.applyMode(mode, label ?? "");
  }

  private applyMode(mode: PixelMode, label: string): void {
    this.pending = null;
    this.mode = mode;
    this.modeFrame = 0;
    if (mode === "done") this.spawnConfetti();
    if (mode !== "writing" && mode !== "responding") this.sparks.length = 0;
    this.label = label;
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

    // La scene d'action a ete vue assez longtemps : le retour differe passe.
    if (this.pending && this.modeFrame >= MIN_SCENE_FRAMES) {
      const p = this.pending;
      this.applyMode(p.mode, p.label);
    }

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
    if ((this.mode === "writing" || this.mode === "responding") && this.frame % 2 === 0) {
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
    const w = Math.max(this.container.clientWidth, STAGE_MIN * SCALE + 8);
    if (w !== this.canvas.width) {
      this.canvas.width = w;
      this.ctx.imageSmoothingEnabled = false;
      this.render();
    }
  }

  /**
   * De combien de lignes la scene est encore enfoncee sous sa hauteur finale.
   *
   * A chaque nouvelle scene le personnage remonte de derriere le fil, avec un
   * leger depassement en fin de course. C'est ce qui le fait exister comme
   * quelqu'un qui arrive, plutot que comme une image qui change.
   */
  private riseOffset(): number {
    const k = this.modeFrame;
    if (k >= ENTER_FRAMES) return 0;
    const u = k / ENTER_FRAMES;
    const eased = 1 - Math.pow(1 - u, 3);
    const overshoot = Math.sin(u * Math.PI) * 1.2;
    return Math.round((1 - eased) * (GRID + BUBBLE_ROWS) - overshoot);
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
    // La scene occupe la bande du bas; la zone du dessus appartient a la
    // bulle. Le reste du rendu continue de raisonner sur GRID lignes, comme
    // avant, sans savoir qu'il a ete descendu.
    const rise = this.riseOffset();
    c.save();
    c.translate(0, (BUBBLE_ROWS + rise) * SCALE);

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
    let ox = 0; // deplacement horizontal (scenes)
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
        // Deambulation lente d'un bord a l'autre : la scene fait toute la
        // largeur de la fenetre, autant l'habiter.
        ox = this.strollX(f, 0.12);
        eyeDx = this.strollForward(f, 0.12);
        break;
      case "thinking":
        oy = f % 16 < 8 ? 0 : 1;
        headDx = f % 24 < 12 ? 0 : 1; // leger balancement
        eyeDx = f % 24 < 12 ? -1 : 1; // regarde en l'air, pensif
        // Il fait les cent pas pendant qu'il reflechit.
        ox = this.strollX(f, 0.2);
        break;
      case "reading": {
        // Exploration : le robot saute de planete en planete.
        const seq = [0, 1, 2, 1];
        const planets = this.planetX();
        const k = Math.floor(mf / HOP_FRAMES) % seq.length;
        const t = (mf % HOP_FRAMES) / HOP_FRAMES;
        const from = planets[seq[k]];
        const to = planets[seq[(k + 1) % seq.length]];
        const ease = t * t * (3 - 2 * t); // smoothstep
        ox = Math.round(from + (to - from) * ease) - 7;
        oy = -2 - Math.round(4.5 * Math.sin(Math.PI * t));
        const airborne = t > 0.12 && t < 0.88;
        arms = airborne ? "up" : "down";
        eyeDx = to > from ? 1 : -1;
        // Poussiere d'atterrissage.
        if (mf % HOP_FRAMES === 0 && mf > 0) {
          for (let i = 0; i < 4; i++) {
            this.sparks.push({
              x: from - 7 + ox + 7.5 + (Math.random() - 0.5) * 3,
              y: 13.5,
              vx: (Math.random() - 0.5) * 1.4,
              vy: -0.3 - Math.random() * 0.4,
              color: Math.random() < 0.5 ? WHITE : ACC2,
              life: 4,
            });
          }
        }
        break;
      }
      case "writing":
        arms = f % 2 === 0 ? "typeL" : "typeR";
        oy = f % 4 < 2 ? 0 : 1; // frappe energique
        break;
      case "responding":
        // Redige la reponse : frappe soutenue, regard vers la bulle.
        arms = f % 2 === 0 ? "typeL" : "typeR";
        oy = f % 4 < 2 ? 0 : 1;
        eyeDx = f % 20 < 10 ? 1 : 0;
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
      case "web":
        // Appel des satellites : telephone en main, regard vers le ciel.
        arms = "hold";
        eyeDx = 1;
        oy = f % 16 < 8 ? 0 : 1;
        headDx = f % 32 < 16 ? 0 : 1;
        break;
      case "doc": {
        // Lecture d'un document : page en main, les yeux balayent les lignes.
        arms = "hold";
        const scan = [-1, -1, 0, 1, 1, 0];
        eyeDx = scan[Math.floor(f / 3) % scan.length];
        oy = f % 20 < 10 ? 0 : 1;
        break;
      }
      case "memory":
        // Memorisation : il regarde l'etoile filer vers le coffre.
        arms = "reach";
        eyeDx = 1;
        oy = f % 16 < 8 ? 0 : 1;
        break;
      case "fleet":
        // Lancement des sous-agents : il salue la flotte au decollage.
        arms = "up";
        eyeDx = 1;
        mouthWide = mf % 24 < 12;
        oy = f % 8 < 4 ? 0 : 1;
        break;
      case "done":
        arms = "up";
        mouthWide = true;
        oy = f % 4 < 2 ? 0 : 1; // sautille de joie
        blink = mf % 12 < 3; // yeux plisses de bonheur
        break;
    }

    // ---- decors derriere le robot
    if (mode === "reading") this.drawPlanets(ox);
    if (mode === "web") this.drawSatellite(f, oy);
    if (mode === "fleet") this.drawFleet(f);

    this.drawRobot(ox, oy, headDx, eyeDx, blink, mouthWide, arms);

    if (mode === "doc") this.drawPage(oy, f);
    if (mode === "memory") this.drawMemoryChest(f, oy);
    if (mode === "responding") this.drawReplyBubble(f);

    // ---- extras par mode (au-dessus du robot)
    if (mode === "thinking") {
      // Points de suspension + petite etoile en orbite autour de la tete.
      const n = Math.floor(f / 4) % 4;
      const xs = [10, 12, 14];
      const ys = [1, 0, 1];
      for (let i = 0; i < 3; i++) {
        if (i < n) this.px(xs[i], ys[i], i === 2 ? WHITE : ACC, 0.95);
      }
      const a = (f / 9) % (Math.PI * 2);
      this.px(7.5 + 6 * Math.cos(a), 5 + 2.6 * Math.sin(a), WHITE, 0.85);
    }

    if (mode === "connector") this.drawBolt(f);

    // ---- particules
    for (const p of this.confetti) this.px(p.x, p.y, p.color, Math.min(1, p.life / 4));
    for (const s of this.sparks) this.px(s.x, s.y, s.color, s.life / 3);

    c.restore();

    // ---- ce qu'il annonce, dans sa bulle, au-dessus de sa tete
    if (this.label) this.drawSpeech(ox, rise);
  }

  /**
   * La bulle que le personnage porte au-dessus de la tete.
   *
   * Elle le suit, donc le texte est toujours a cote de celui qui l'annonce.
   * Le cadre est en pixels logiques pour rester dans le meme langage
   * graphique que le sprite, le texte est rendu en pixels ecran pour rester
   * lisible: un texte dessine a la grille x3 serait illisible a cette taille.
   *
   * A chaque changement d'annonce la bulle se regonfle depuis la queue, ce qui
   * donne le sentiment qu'il vient de la poser plutot qu'elle n'a ete
   * remplacee en silence.
   */
  private drawSpeech(ox: number, rise: number): void {
    const c = this.ctx;
    const pop = Math.min(1, this.modeFrame / POP_FRAMES);
    if (pop <= 0) return;

    c.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    const padX = 3; // en lignes logiques
    const headX = ox + 8; // milieu de la tete du robot
    const maxTextW = Math.max(40, this.canvas.width - 24);
    const text = this.ellipsize(this.label, maxTextW);
    const textW = c.measureText(text).width;
    const wRows = Math.ceil(textW / SCALE) + padX * 2;

    // Ancrage: centree sur la tete, mais jamais hors champ.
    const stage = this.stageW();
    let x0 = Math.round(headX - wRows / 2);
    x0 = Math.max(1, Math.min(x0, stage - wRows - 1));
    const bottom = BUBBLE_ROWS - 3 + rise; // laisse deux lignes pour la queue
    const hRows = 7;
    const y0 = bottom - hRows;
    if (y0 < -hRows) return; // encore derriere le fil, rien a montrer

    // Gonflement: la bulle grandit depuis la queue.
    const gx = x0 + wRows / 2;
    const gy = bottom;
    c.save();
    c.translate(gx * SCALE, gy * SCALE);
    c.scale(pop, pop);
    c.translate(-gx * SCALE, -gy * SCALE);

    // Cadre, coins evides pour un arrondi pixel.
    for (let x = x0; x < x0 + wRows; x++) {
      this.px(x, y0, ACC, 0.34);
      this.px(x, y0 + hRows - 1, ACC, 0.34);
    }
    for (let y = y0; y < y0 + hRows; y++) {
      this.px(x0, y, ACC, 0.34);
      this.px(x0 + wRows - 1, y, ACC, 0.34);
    }
    for (const [cx, cy] of [[x0, y0], [x0 + wRows - 1, y0], [x0, y0 + hRows - 1], [x0 + wRows - 1, y0 + hRows - 1]] as const) {
      c.clearRect(cx * SCALE, cy * SCALE, SCALE, SCALE);
    }
    // Queue vers la tete.
    this.px(Math.round(headX), y0 + hRows, ACC, 0.34);
    this.px(Math.round(headX), y0 + hRows + 1, ACC, 0.22);

    // Texte, centre dans la bulle.
    c.globalAlpha = 1;
    c.fillStyle = LABEL_COLOR;
    c.textBaseline = "middle";
    c.textAlign = "center";
    c.fillText(text, (x0 + wRows / 2) * SCALE, (y0 + hRows / 2) * SCALE + 1);
    c.restore();
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
    ox: number,
    oy: number,
    headDx: number,
    eyeDx: number,
    blink: boolean,
    mouthWide: boolean,
    arms: "down" | "typeL" | "typeR" | "up" | "reach" | "hold",
  ): void {
    const f = this.frame;
    const P = (x: number, y: number, col: string, a = 1): void => this.px(x + ox, y + oy, col, a);

    // Antenne (le corps porte l'antenne ; la tete balance avec headDx)
    P(7 + headDx, 2, ACC2);
    P(7 + headDx, 1, f % 24 < 12 ? WHITE : ACC2, f % 24 < 12 ? 1 : 0.8); // tip clignotant

    // Tete (8x6, coins arrondis), legerement etoilee par l'antenne
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

  /** Chapelet de planetes que le robot explore (mode reading/recherche). */
  private drawPlanets(robotOx: number): void {
    const robotCenter = robotOx + 7.5;
    for (const cx of this.planetX()) {
      const near = Math.abs(robotCenter - cx) < 3.5; // planete visitee : eclairee
      const body = near ? ACC2 : ACC;
      const glow = near ? 0.95 : 0.55;
      // Dome
      this.px(cx - 1, 13, body, glow);
      this.px(cx, 13, body, glow);
      this.px(cx + 1, 13, body, glow);
      this.px(cx - 2, 14, body, glow * 0.85);
      this.px(cx - 1, 14, body, glow);
      this.px(cx, 14, near ? WHITE : body, glow);
      this.px(cx + 1, 14, body, glow);
      this.px(cx + 2, 14, body, glow * 0.85);
      // Anneau
      this.px(cx - 3, 14.5, ACC2, near ? 0.7 : 0.3);
      this.px(cx + 3, 14.5, ACC2, near ? 0.7 : 0.3);
      // Base
      this.px(cx - 1, 15, body, glow * 0.7);
      this.px(cx, 15, body, glow * 0.7);
      this.px(cx + 1, 15, body, glow * 0.7);
    }
    // Quelques etoiles fixes au-dessus de la scene
    const stars: [number, number][] = [[2, 1], [9, 3], [17, 1], [25, 2], [28, 5]];
    for (let i = 0; i < stars.length; i++) {
      const tw = (this.frame + i * 5) % 22 < 11 ? 0.5 : 0.2;
      this.px(stars[i][0], stars[i][1], WHITE, tw);
    }
  }

  /** Page tenue devant le robot (mode doc : lecture d'un document). */
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

  /** Bulle de reponse a droite du robot : le texte s'y ecrit en boucle. */
  private drawReplyBubble(f: number): void {
    const x0 = 19; // interieur : x0..x0+8, trois lignes de texte
    const y0 = 3;
    const w = 9;
    // Cadre discret + queue vers le robot.
    for (let x = x0 - 1; x <= x0 + w; x++) { this.px(x, y0 - 1, ACC, 0.22); this.px(x, y0 + 5, ACC, 0.22); }
    for (let y = y0 - 1; y <= y0 + 5; y++) { this.px(x0 - 2, y, ACC, 0.22); this.px(x0 + w + 1, y, ACC, 0.22); }
    this.px(x0 - 3, y0 + 3, ACC, 0.3);
    this.px(x0 - 4, y0 + 4, ACC, 0.2);
    // Trois lignes qui se remplissent pixel a pixel, curseur blanc en tete,
    // petite pause une fois la bulle pleine puis on recommence.
    const total = 3 * w;
    const done = Math.floor(f / 2) % (total + 10);
    for (let i = 0; i < Math.min(done, total); i++) {
      const line = Math.floor(i / w);
      const col = i % w;
      const head = i === done - 1;
      this.px(x0 + col, y0 + line * 2, head ? WHITE : ACC2, head ? 0.95 : 0.5);
    }
  }

  /** Une etoile file de la tete du robot vers le coffre a souvenirs (memory). */
  private drawMemoryChest(f: number, robotOy: number): void {
    // Coffre a droite
    const flash = f % 18 < 3;
    this.px(13, 11, ACC2, 0.9); this.px(14, 11, flash ? WHITE : ACC2, 0.95); this.px(15, 11, ACC2, 0.9); // couvercle
    this.px(13, 12, ACC, 0.85); this.px(14, 12, ACC, 0.85); this.px(15, 12, ACC, 0.85);
    this.px(13, 13, ACC, 0.85); this.px(14, 13, flash ? WHITE : ACC2, 0.9); this.px(15, 13, ACC, 0.85);
    if (flash) { this.px(14, 10, WHITE, 0.8); this.px(12.5, 10.5, ACC2, 0.6); this.px(15.5, 10.5, ACC2, 0.6); }
    // L'etoile : arc parametrique de la tete (8,4) au coffre (14,11)
    const t = (f % 18) / 18;
    if (t < 0.85) {
      const x = 8 + (14 - 8) * t;
      const y = 4 + robotOy + (11 - 4) * t - 3.2 * Math.sin(Math.PI * t);
      this.px(x, y, WHITE, 0.95);
      this.px(x - 0.7, y + 0.3, ACC2, 0.5); // traine
    }
  }

  /** Flotte de sous-agents au decollage (mode fleet). */
  private drawFleet(f: number): void {
    // Pas de tir repartis sur la moitie droite, quelle que soit la largeur.
    const w = this.stageW();
    const base = Math.max(17, Math.floor(w * 0.45));
    const step = Math.max(4, Math.floor((w - base - 6) / 3));
    const pads = [base, base + step, base + 2 * step];
    for (let i = 0; i < pads.length; i++) {
      const x = pads[i];
      // Pas de tir
      this.px(x - 1, 15, ACC, 0.5); this.px(x, 15, ACC, 0.7); this.px(x + 1, 15, ACC, 0.5);
      // Fusee : monte en boucle, decalage par pas de tir
      const ry = 14 - ((f * 0.9 + i * 9) % 22);
      if (ry > -2) {
        this.px(x, ry - 1, WHITE, 0.95); // nez
        this.px(x, ry, ACC2); // corps
        this.px(x, ry + 1, ACC2);
        this.px(x - 1, ry + 1, ACC, 0.7); // ailerons
        this.px(x + 1, ry + 1, ACC, 0.7);
        // Flamme
        const hot = (f + i) % 4 < 2;
        this.px(x, ry + 2, hot ? WHITE : ACC2, 0.9);
        this.px(x, ry + 3, ACC2, hot ? 0.6 : 0.3);
      }
    }
  }

  /** Satellite en transit + liaison radio depuis le telephone (mode web). */
  private drawSatellite(f: number, robotOy: number): void {
    // Telephone dans la main droite du robot
    this.px(12, 10 + robotOy, WHITE, 0.95);
    this.px(12, 11 + robotOy, f % 8 < 4 ? ACC2 : WHITE, 0.9); // ecran qui clignote
    // Satellite qui traverse le ciel (droite vers gauche, en boucle)
    const span = Math.max(16, this.stageW() - 4);
    const sx = span - ((f / 2) % span);
    this.px(sx, 2, ACC2); // corps
    this.px(sx + 1, 2, ACC2);
    this.px(sx - 2, 2, ACC, 0.85); // panneau gauche
    this.px(sx - 3, 2, ACC, 0.6);
    this.px(sx + 3, 2, ACC, 0.85); // panneau droit
    this.px(sx + 4, 2, ACC, 0.6);
    this.px(sx, 1, WHITE, f % 10 < 5 ? 0.95 : 0.4); // antenne clignotante
    // Ondes radio : pointilles du telephone vers le satellite
    const x0 = 13, y0 = 9 + robotOy;
    const dx = sx - x0, dy = 2 - y0;
    for (let i = 0; i < 4; i++) {
      const t = 0.2 + i * 0.2;
      const on = (f + i * 2) % 8 < 4;
      this.px(x0 + dx * t, y0 + dy * t + (i % 2 === 0 ? -0.5 : 0.5), on ? WHITE : ACC2, on ? 0.85 : 0.35);
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
