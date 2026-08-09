export type PaneEdge = "before" | "after";

export interface PaneBounds {
  /** Full horizontal space owned by the split container. */
  container: number;
  /** Space that must remain for the other panes. */
  reserved: number;
  min: number;
  max: number;
  defaultSize: number;
}

export function constrainedPaneSize(candidate: number, bounds: PaneBounds): number {
  const availableMax = Math.max(bounds.min, bounds.container - bounds.reserved);
  const effectiveMax = Math.max(bounds.min, Math.min(bounds.max, availableMax));
  return Math.round(Math.min(Math.max(candidate, bounds.min), effectiveMax));
}

export function pointerPaneSize(
  pointerX: number,
  containerLeft: number,
  containerRight: number,
  edge: PaneEdge
): number {
  return Math.round(edge === "before" ? pointerX - containerLeft : containerRight - pointerX);
}

export function keyboardPaneSize(
  current: number,
  key: string,
  largeStep: boolean,
  edge: PaneEdge,
  bounds: PaneBounds
): number | null {
  if (key === "Home") return constrainedPaneSize(bounds.defaultSize, bounds);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const step = largeStep ? 48 : 16;
  const visualDirection = key === "ArrowRight" ? 1 : -1;
  const paneDirection = edge === "before" ? visualDirection : -visualDirection;
  return constrainedPaneSize(current + paneDirection * step, bounds);
}

export function storedPaneSize(raw: string | undefined, bounds: PaneBounds): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return constrainedPaneSize(bounds.defaultSize, bounds);
  }
  return constrainedPaneSize(parsed, bounds);
}

export interface PaneResizeSessionOptions {
  edge: PaneEdge;
  initial: number;
  bounds(): PaneBounds;
  apply(size: number): void;
  commit(size: number): void;
}

export interface PaneResizeSession {
  movePointer(pointerX: number, containerLeft: number, containerRight: number): void;
  commitPointer(): void;
  key(key: string, largeStep: boolean): boolean;
  reset(): void;
  size(): number;
}

/**
 * State machine shared by mouse, trackpad and keyboard resize handles. Pointer
 * movement is preview-only; storage is touched once on release, while keyboard
 * steps commit immediately because each press is a complete interaction.
 */
export function createPaneResizeSession(options: PaneResizeSessionOptions): PaneResizeSession {
  let current = constrainedPaneSize(options.initial, options.bounds());
  const apply = (next: number, commit: boolean) => {
    current = constrainedPaneSize(next, options.bounds());
    options.apply(current);
    if (commit) options.commit(current);
  };
  return {
    movePointer(pointerX, containerLeft, containerRight) {
      apply(pointerPaneSize(pointerX, containerLeft, containerRight, options.edge), false);
    },
    commitPointer() {
      options.commit(current);
    },
    key(key, largeStep) {
      const next = keyboardPaneSize(current, key, largeStep, options.edge, options.bounds());
      if (next === null) return false;
      apply(next, true);
      return true;
    },
    reset() {
      apply(options.bounds().defaultSize, true);
    },
    size() {
      return current;
    },
  };
}

type SavePanePreference = (key: string, value: string) => Promise<unknown> | unknown;

let panePreferences: Record<string, string> = {};
let savePanePreference: SavePanePreference | null = null;

/** Configure once from the app settings loaded during boot. */
export function configurePanePreferences(
  values: Record<string, string>,
  save: SavePanePreference
): void {
  panePreferences = { ...values };
  savePanePreference = save;
}

export interface PaneResizerOptions {
  handle: HTMLElement;
  container: HTMLElement;
  pane: HTMLElement;
  edge: PaneEdge;
  setting: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  defaultSize: number;
  /** Dynamic pixels occupied by everything that must remain visible. */
  reserved(): number;
}

/** Wire one native-feeling vertical separator. The returned cleanup is safe to call repeatedly. */
export function wirePaneResizer(options: PaneResizerOptions): () => void {
  const bounds = (): PaneBounds => ({
    container: options.container.clientWidth || window.innerWidth,
    reserved: options.reserved(),
    min: options.min,
    max: options.max,
    defaultSize: options.defaultSize,
  });
  const initial = storedPaneSize(panePreferences[options.setting], bounds());
  const refreshAria = (size: number) => {
    const b = bounds();
    const max = Math.max(b.min, Math.min(b.max, b.container - b.reserved));
    options.handle.setAttribute("aria-valuemin", String(b.min));
    options.handle.setAttribute("aria-valuemax", String(Math.round(max)));
    options.handle.setAttribute("aria-valuenow", String(size));
    options.handle.setAttribute("aria-valuetext", `${size} pixels`);
  };
  const apply = (size: number) => {
    options.pane.style.width = `${size}px`;
    refreshAria(size);
  };
  const commit = (size: number) => {
    panePreferences[options.setting] = String(size);
    void Promise.resolve(savePanePreference?.(options.setting, String(size))).catch(() => {});
  };
  const session = createPaneResizeSession({
    edge: options.edge,
    initial,
    bounds,
    apply,
    commit,
  });

  options.handle.setAttribute("role", "separator");
  options.handle.setAttribute("aria-orientation", "vertical");
  options.handle.setAttribute("aria-label", options.label);
  options.handle.setAttribute("tabindex", "0");
  options.handle.title = options.hint ? `${options.label} · ${options.hint}` : options.label;
  apply(session.size());

  let dragging = false;
  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    options.handle.classList.remove("dragging");
    document.documentElement.classList.remove("pane-dragging");
    session.commitPointer();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    options.handle.classList.add("dragging");
    document.documentElement.classList.add("pane-dragging");
    options.handle.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    const rect = options.container.getBoundingClientRect();
    session.movePointer(event.clientX, rect.left, rect.right);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!session.key(event.key, event.shiftKey)) return;
    event.preventDefault();
  };
  const onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    session.reset();
  };

  options.handle.addEventListener("pointerdown", onPointerDown);
  options.handle.addEventListener("pointermove", onPointerMove);
  options.handle.addEventListener("pointerup", stopDragging);
  options.handle.addEventListener("lostpointercapture", stopDragging);
  options.handle.addEventListener("keydown", onKeyDown);
  options.handle.addEventListener("dblclick", onDoubleClick);

  return () => {
    options.handle.removeEventListener("pointerdown", onPointerDown);
    options.handle.removeEventListener("pointermove", onPointerMove);
    options.handle.removeEventListener("pointerup", stopDragging);
    options.handle.removeEventListener("lostpointercapture", stopDragging);
    options.handle.removeEventListener("keydown", onKeyDown);
    options.handle.removeEventListener("dblclick", onDoubleClick);
    if (dragging) {
      dragging = false;
      document.documentElement.classList.remove("pane-dragging");
    }
  };
}
