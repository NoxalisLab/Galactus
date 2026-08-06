// Constellation Obsidian : les notes du coffre en champ d'étoiles 3D.
//
// Rendu canvas 2D pur (pas de WebGL, pas de dépendance, compatible CSP) :
// projection perspective maison, rotation auto + glisser pour orbiter,
// molette pour zoomer, survol pour lire le nom d'une note. Les positions
// viennent d'une petite simulation de forces 3D (ressorts sur les liens,
// répulsion douce), calculée une fois au chargement.

export interface CosmosData {
  nodes: { n: string; p: string; d: number }[];
  edges: [number, number][];
}

const MAX_NODES = 500;

interface Star {
  name: string;
  path: string;
  degree: number;
  x: number; y: number; z: number;
  // projeté (recalculé chaque frame)
  px: number; py: number; ps: number; depth: number;
}

export class Cosmos {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stars: Star[] = [];
  private edges: [number, number][] = [];
  private raf = 0;
  private rotY = 0;
  private rotX = 0.25;
  private autoSpin = true;
  private zoom = 1;
  private dragging = false;
  private lastMx = 0;
  private lastMy = 0;
  private mouseX = -1;
  private mouseY = -1;
  private hovered: Star | null = null;
  private destroyed = false;
  private dust: { x: number; y: number; r: number; a: number }[] = [];

  constructor(
    private host: HTMLElement,
    data: CosmosData,
    private onSelect?: (name: string, path: string) => void
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cosmos-canvas";
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d indisponible");
    this.ctx = ctx;
    host.appendChild(this.canvas);
    this.build(data);
    this.wire();
    this.resize();
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.canvas.remove();
  }

  // ---- construction : sélection des nœuds + layout par forces ----

  private build(data: CosmosData): void {
    // Les nœuds les plus connectés d'abord ; les orphelins complètent.
    const order = data.nodes
      .map((node, i) => ({ node, i }))
      .sort((a, b) => b.node.d - a.node.d)
      .slice(0, MAX_NODES);
    const keep = new Map<number, number>();
    order.forEach((entry, fresh) => keep.set(entry.i, fresh));

    // Position initiale : spirale de Fibonacci sur une sphère.
    const n = order.length;
    const golden = Math.PI * (3 - Math.sqrt(5));
    this.stars = order.map((entry, i) => {
      const t = n > 1 ? i / (n - 1) : 0.5;
      const inc = Math.acos(1 - 2 * t);
      const az = golden * i;
      const r = 190;
      return {
        name: entry.node.n,
        path: entry.node.p,
        degree: entry.node.d,
        x: r * Math.sin(inc) * Math.cos(az),
        y: r * Math.sin(inc) * Math.sin(az),
        z: r * Math.cos(inc),
        px: 0, py: 0, ps: 0, depth: 0,
      };
    });
    this.edges = data.edges
      .filter(([a, b]) => keep.has(a) && keep.has(b))
      .map(([a, b]) => [keep.get(a)!, keep.get(b)!] as [number, number]);

    // Simulation courte : ressorts sur les liens, répulsion douce, rappel
    // vers une coquille pour garder la forme de nébuleuse.
    const s = this.stars;
    for (let iter = 0; iter < 110; iter++) {
      const fx = new Float32Array(s.length);
      const fy = new Float32Array(s.length);
      const fz = new Float32Array(s.length);
      for (const [a, b] of this.edges) {
        const dx = s[b].x - s[a].x, dy = s[b].y - s[a].y, dz = s[b].z - s[a].z;
        const dist = Math.max(Math.hypot(dx, dy, dz), 1);
        const pull = (dist - 60) * 0.012;
        fx[a] += (dx / dist) * pull; fy[a] += (dy / dist) * pull; fz[a] += (dz / dist) * pull;
        fx[b] -= (dx / dist) * pull; fy[b] -= (dy / dist) * pull; fz[b] -= (dz / dist) * pull;
      }
      if (s.length <= 420) {
        for (let i = 0; i < s.length; i++) {
          for (let j = i + 1; j < s.length; j++) {
            const dx = s[j].x - s[i].x, dy = s[j].y - s[i].y, dz = s[j].z - s[i].z;
            const d2 = dx * dx + dy * dy + dz * dz + 25;
            const rep = 900 / d2;
            const d = Math.sqrt(d2);
            fx[i] -= (dx / d) * rep; fy[i] -= (dy / d) * rep; fz[i] -= (dz / d) * rep;
            fx[j] += (dx / d) * rep; fy[j] += (dy / d) * rep; fz[j] += (dz / d) * rep;
          }
        }
      }
      for (let i = 0; i < s.length; i++) {
        const r = Math.max(Math.hypot(s[i].x, s[i].y, s[i].z), 1);
        const shell = (170 - r) * 0.004; // rappel doux vers la coquille
        fx[i] += (s[i].x / r) * shell; fy[i] += (s[i].y / r) * shell; fz[i] += (s[i].z / r) * shell;
        s[i].x += Math.max(-8, Math.min(8, fx[i]));
        s[i].y += Math.max(-8, Math.min(8, fy[i]));
        s[i].z += Math.max(-8, Math.min(8, fz[i]));
      }
    }

    // Poussière d'arrière-plan (fixe, dessinée en repère écran).
    const dustRng = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(42);
    this.dust = Array.from({ length: 130 }, () => ({
      x: dustRng(), y: dustRng(), r: 0.4 + dustRng() * 0.9, a: 0.06 + dustRng() * 0.22,
    }));
  }

  // ---- interaction ----

  private wire(): void {
    window.addEventListener("resize", this.resize);
    let downX = 0, downY = 0;
    this.canvas.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.autoSpin = false;
      this.lastMx = e.clientX; this.lastMy = e.clientY;
      downX = e.clientX; downY = e.clientY;
    });
    window.addEventListener("mouseup", (e) => {
      const wasDragging = this.dragging;
      this.dragging = false;
      // Un vrai clic (pas un glisser) sur une etoile ouvre la note.
      if (wasDragging && Math.hypot(e.clientX - downX, e.clientY - downY) < 4 && this.hovered && this.onSelect) {
        this.onSelect(this.hovered.name, this.hovered.path);
      }
    });
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
      if (this.dragging) {
        this.rotY += (e.clientX - this.lastMx) * 0.005;
        this.rotX += (e.clientY - this.lastMy) * 0.005;
        this.rotX = Math.max(-1.4, Math.min(1.4, this.rotX));
        this.lastMx = e.clientX; this.lastMy = e.clientY;
      }
    });
    this.canvas.addEventListener("mouseleave", () => { this.mouseX = -1; this.mouseY = -1; });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.4, Math.min(3, this.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    }, { passive: false });
    this.canvas.addEventListener("dblclick", () => { this.autoSpin = true; });
  }

  private resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // ---- rendu ----

  private tick = (): void => {
    if (this.destroyed) return;
    if (this.autoSpin) this.rotY += 0.0022;
    this.render();
    this.raf = requestAnimationFrame(this.tick);
  };

  private render(): void {
    const ctx = this.ctx;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    for (const d of this.dust) {
      ctx.globalAlpha = d.a;
      ctx.fillStyle = "#cfc8ff";
      ctx.beginPath();
      ctx.arc(d.x * w, d.y * h, d.r, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Projection : rotation X puis Y, perspective simple.
    const sy = Math.sin(this.rotY), cyr = Math.cos(this.rotY);
    const sx = Math.sin(this.rotX), cxr = Math.cos(this.rotX);
    const fov = 560 * this.zoom;
    for (const star of this.stars) {
      const y1 = star.y * cxr - star.z * sx;
      const z1 = star.y * sx + star.z * cxr;
      const x2 = star.x * cyr + z1 * sy;
      const z2 = -star.x * sy + z1 * cyr;
      const depth = z2 + 460;
      const k = fov / Math.max(depth, 60);
      star.px = cx + x2 * k;
      star.py = cy + y1 * k;
      star.ps = k;
      star.depth = depth;
    }

    // Liens : filaments discrets, plus présents à l'avant.
    ctx.lineWidth = 0.7;
    for (const [a, b] of this.edges) {
      const A = this.stars[a], B = this.stars[b];
      const near = Math.min(A.depth, B.depth);
      const alpha = Math.max(0.03, Math.min(0.22, (620 - near) / 1600));
      ctx.strokeStyle = `rgba(138, 124, 255, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(A.px, A.py);
      ctx.lineTo(B.px, B.py);
      ctx.stroke();
    }

    // Étoiles : triées par profondeur, halo violet, cœur clair.
    const order = [...this.stars].sort((a, b) => b.depth - a.depth);
    let hovered: Star | null = null;
    let hoverDist = 12;
    for (const star of order) {
      const size = (1.3 + Math.min(Math.sqrt(star.degree), 6) * 0.9) * star.ps * 0.9;
      const fade = Math.max(0.25, Math.min(1, (700 - star.depth) / 420));
      const glow = ctx.createRadialGradient(star.px, star.py, 0, star.px, star.py, size * 3.2);
      glow.addColorStop(0, `rgba(176, 108, 255, ${(0.5 * fade).toFixed(3)})`);
      glow.addColorStop(1, "rgba(176, 108, 255, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(star.px, star.py, size * 3.2, 0, 7);
      ctx.fill();
      ctx.fillStyle = `rgba(235, 230, 255, ${fade.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(star.px, star.py, Math.max(size, 0.8), 0, 7);
      ctx.fill();
      if (this.mouseX >= 0) {
        const dm = Math.hypot(star.px - this.mouseX, star.py - this.mouseY);
        if (dm < hoverDist) { hoverDist = dm; hovered = star; }
      }
    }
    this.hovered = hovered;

    // Étiquette de survol.
    if (this.hovered) {
      const s = this.hovered;
      ctx.font = "12px 'IBM Plex Sans', sans-serif";
      const label = s.name;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(s.px + 12, 8), w - tw - 18);
      const ly = Math.min(Math.max(s.py - 10, 22), h - 12);
      ctx.fillStyle = "rgba(12, 12, 16, 0.88)";
      ctx.strokeStyle = "rgba(138, 124, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(lx - 7, ly - 15, tw + 14, 22, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#e9e9ef";
      ctx.fillText(label, lx, ly);
    }
  }
}
