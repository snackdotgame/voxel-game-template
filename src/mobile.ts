/*
 *      Mobile / touch controls
 *
 *  An optional on-screen control layer for touch devices, modeled on the
 *  sibling fps-game-template (which hand-rolls its joystick — no library):
 *
 *    - one full-screen pointer-capture surface drives BOTH a floating
 *      left-thumb joystick (touch in the left ~45%) and look (touch anywhere
 *      else). Because the surface calls setPointerCapture on press, a look
 *      drag keeps steering even when the finger slides over a button;
 *    - the joystick writes the movement booleans the sim samples each tick
 *      (8-way + sprint at the edge), look feeds pointerState.dx/dy like the
 *      mouse, and the buttons emit the same fire / alt-fire / mid-fire input
 *      events the keyboard/mouse handlers use — so no netcode/sim changes;
 *    - Jump, first/third-person View, and Inventory buttons cover the keys
 *      (space / V / E) with no touch equivalent; hotbar slots become tappable.
 *
 *  Layout: the Snack host shell pins its own menu controls to the top-left
 *  corner (`.snack-shell-controls`: top/left max(8px, safe-area), ~44px tall,
 *  z-index 70), so the View/Inventory buttons sit in a column BELOW that strip.
 *  The action cluster sits bottom-right, raised above the hotbar (which spans
 *  nearly the full width of a portrait phone once scaled to fit). Buttons show
 *  icons, not words — SVG paths inlined from Lucide (https://lucide.dev,
 *  ISC license) so no icon dependency is added.
 *
 *  Fullscreen: an explicit button in the left column (never auto-requested —
 *  Android answers requestFullscreen with a modal "Viewing full screen / Got
 *  it" education sheet that silently eats EVERY touch until dismissed, so an
 *  auto-request on the first tap made the game feel dead at session start;
 *  see setupFullscreenButton) and sizes the game to the dynamic viewport. The
 *  controls are
 *  pinned to the visible rect via the visualViewport API + safe-area insets, so
 *  the browser's bottom toolbar in portrait can't cover them. We deliberately do
 *  NOT force landscape (unlike the fps template).
 */

import type { Engine } from "./noa/index.js";

export type MobileControlOptions = {
  noa: Engine;
  /** the HUD hotbar container (moved into the viewport-tracked overlay) */
  hotbarEl: HTMLElement;
  /** the HUD hotbar slot tiles, made tappable to select that slot */
  hotbarSlots: { root: HTMLElement }[];
  /** the desktop keybinding hint panel, hidden on touch (joystick sits there) */
  helpPanel: HTMLElement;
  selectSlot: (slot: number) => void;
  /** toggle first/third person (the desktop V key) */
  toggleView: () => void;
  /** toggle the inventory screen (the desktop E key) */
  openInventory: () => void;
};

// look speed: deltas are fed into pointerState, which noa's camera multiplies by
// ~0.066 deg/px — tune in playtest.
const LOOK_SENS_X = 6;
const LOOK_SENS_Y = 5;
const JOY_RADIUS = 55; // px of knob travel
const JOY_DEAD = 0.22; // fraction of radius ignored before a direction counts
const SPRINT_MAG = 0.82; // push past this fraction of full deflection to sprint
const MOVE_SIDE_FRACTION = 0.45; // left fraction of the screen is the joystick zone

/*
 *      Icons
 *
 *  Path data copied from Lucide (https://lucide.dev), lucide-static v0.525.0,
 *  ISC license. Rendered as 24x24 stroke icons that inherit the button color.
 */
const ICON_PICKAXE =
  '<path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912"/>' +
  '<path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393"/>' +
  '<path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z"/>' +
  '<path d="M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319"/>';
const ICON_ARROW_BIG_UP = '<path d="M9 18v-6H5l7-7 7 7h-4v6H9z"/>';
const ICON_BOX =
  '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
  '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>';
const ICON_SEND =
  '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>' +
  '<path d="m21.854 2.147-10.94 10.939"/>';
const ICON_SWITCH_CAMERA =
  '<path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>' +
  '<path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"/>' +
  '<circle cx="12" cy="12" r="3"/><path d="m18 22-3-3 3-3"/><path d="m6 2 3 3-3 3"/>';
const ICON_BACKPACK =
  '<path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>' +
  '<path d="M8 10h8"/><path d="M8 18h8"/>' +
  '<path d="M8 22v-6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6"/>' +
  '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>';
const ICON_MOVE =
  '<path d="M12 2v20"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/>' +
  '<path d="M2 12h20"/><path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/>';
const ICON_MAXIMIZE =
  '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>' +
  '<path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>';
const ICON_MINIMIZE =
  '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/>' +
  '<path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>';

function svgIcon(paths: string, size: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
    ` style="pointer-events: none; display: block;">${paths}</svg>`
  );
}

// The Snack host shell rewrites the game frame's URL, dropping any query
// params the shell page was opened with — and referrers are origin-only cross
// origin — so `?touch=1` can't reach the game through the shell. localStorage
// (set once on the game's origin from devtools) works as a sticky override.
function touchOverride(): string | null {
  const own = new URLSearchParams(window.location.search).get("touch");
  if (own !== null) {
    return own;
  }
  try {
    return localStorage.getItem("snack-touch");
  } catch {
    return null;
  }
}

/**
 * Whether to show touch controls. Auto-detects a coarse-pointer touch device;
 * override for desktop testing with `?touch=1` / `?touch=0` in the URL, or —
 * since the host shell strips the game frame's query params — by running
 * `localStorage.setItem("snack-touch", "1")` in the game frame's console.
 */
export function isTouchDevice(): boolean {
  const override = touchOverride();
  if (override === "1" || override === "true") {
    return true;
  }
  if (override === "0" || override === "false") {
    return false;
  }
  return (
    (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false) ||
    (navigator.maxTouchPoints ?? 0) > 0
  );
}

/**
 * Builds the touch control overlay if this looks like a touch device.
 * Returns true if controls were installed, false on desktop (no-op).
 */
export function setupMobileControls(opts: MobileControlOptions): boolean {
  if (!isTouchDevice()) {
    return false;
  }
  const { noa } = opts;

  // The camera ignores look input while pointer lock is unavailable (its
  // `sensitivityMultOutsidePointerlock` defaults to 0). Touch never holds
  // pointer lock, so force the camera to always read pointerState.
  noa.container.supportsPointerLock = false;
  noa.camera.sensitivityMultOutsidePointerlock = 1;

  // the joystick lives bottom-left where the keybinding hints render
  opts.helpPanel.style.display = "none";

  sizeGameToVisibleViewport();
  const root = buildOverlayRoot();
  setupSurface(noa, root);
  // hotbar before the buttons so the corner buttons stack above it
  attachHotbar(root, opts);
  setupActionButtons(noa, root, opts);
  setupInventoryButton(root, opts);
  return true;
}

/*
 *      Fullscreen + viewport
 *
 *  Two problems on phones: the address bar eats vertical space, and in portrait
 *  the browser's bottom toolbar can sit over the controls. Fixes, in order of
 *  effectiveness: (1) request real fullscreen on the first tap — on Android this
 *  removes all browser chrome; (2) size the game to the dynamic viewport so it
 *  fills whatever is visible; (3) pin the controls overlay to the visualViewport
 *  rect so it tracks the visible area even when chrome shows/hides.
 */
function sizeGameToVisibleViewport(): void {
  const style = document.createElement("style");
  // noa pins its container with top/bottom:0 + height:100%, which on mobile
  // resolves to the *large* viewport (behind the address bar). Switch it to the
  // dynamic viewport so the canvas + centered crosshair fit what's on screen.
  style.textContent =
    "html, body { overscroll-behavior: none; }" +
    "#noa-container { height: 100dvh !important; bottom: auto !important; }";
  document.head.appendChild(style);

  // entering/leaving fullscreen changes the canvas size — let noa re-measure
  document.addEventListener("fullscreenchange", () => {
    window.dispatchEvent(new Event("resize"));
  });
}

// A fixed root pinned to the visualViewport rect. The `transform` makes it the
// containing block for the position:fixed hotbar we move inside, so that hotbar
// is positioned against the *visible* viewport too. z-index 15 keeps the whole
// overlay below the inventory backdrop (z 20) so the inventory stays usable.
function buildOverlayRoot(): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "snack-touch";
  root.style.cssText =
    "position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 15;" +
    "pointer-events: none; transform: translateZ(0); touch-action: none;" +
    "-webkit-user-select: none; user-select: none; -webkit-touch-callout: none;";
  document.body.appendChild(root);

  const vv = window.visualViewport;
  if (vv) {
    const sync = (): void => {
      root.style.width = `${vv.width}px`;
      root.style.height = `${vv.height}px`;
      root.style.left = `${vv.offsetLeft}px`;
      root.style.top = `${vv.offsetTop}px`;
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
  }
  return root;
}

/*
 *      "Drag to move" hint
 *
 *  A pulsing pill floating in the joystick zone so new players discover the
 *  invisible floating joystick. Removed on the first move-drag (the gesture it
 *  teaches), or a while after the first touch for players who are busy
 *  looking/mining instead. The timeout is armed by the first touch — not
 *  install time — because blocking overlays (the character creator) sit above
 *  the touch surface, and the hint shouldn't burn down behind them.
 */
const HINT_TIMEOUT_MS = 12000;

type MoveHint = { dismiss: () => void; armTimeout: () => void };

function showMoveHint(root: HTMLElement): MoveHint {
  const style = document.createElement("style");
  style.textContent =
    "@keyframes snack-hint-pulse { 0%, 100% { transform: translateX(-50%) scale(1); }" +
    " 50% { transform: translateX(-50%) scale(1.07); } }";
  document.head.appendChild(style);

  const hint = document.createElement("div");
  hint.innerHTML = `${svgIcon(ICON_MOVE, 18)}<span>Drag to move</span>`;
  hint.style.cssText =
    "position: absolute; left: 22%; bottom: 32%; transform: translateX(-50%);" +
    "display: flex; align-items: center; gap: 8px; padding: 10px 16px;" +
    "border-radius: 999px; color: #fff; font: 600 13px/1 system-ui, sans-serif;" +
    "background: rgba(20,20,28,0.6); border: 1px solid rgba(255,255,255,0.25);" +
    "pointer-events: none; white-space: nowrap;" +
    "animation: snack-hint-pulse 1.6s ease-in-out infinite;";
  root.appendChild(hint);

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) {
      return;
    }
    dismissed = true;
    hint.style.animation = "";
    hint.style.transition = "opacity 0.4s";
    hint.style.opacity = "0";
    setTimeout(() => {
      hint.remove();
      style.remove();
    }, 450);
  };
  let armed = false;
  const armTimeout = (): void => {
    if (armed || dismissed) {
      return;
    }
    armed = true;
    setTimeout(dismiss, HINT_TIMEOUT_MS);
  };
  return { dismiss, armTimeout };
}

/*
 *      Joystick + look on one pointer-capture surface
 */
function setupSurface(noa: Engine, root: HTMLElement): void {
  const surface = document.createElement("div");
  surface.style.cssText = "position: absolute; inset: 0; pointer-events: auto; touch-action: none;";
  root.appendChild(surface);
  // CSS touch-action does not stop iOS edge navigation by itself; preventing
  // touchstart keeps left-edge look drags from pulling the page away.
  surface.addEventListener("touchstart", (ev) => ev.preventDefault(), { passive: false });

  const joybase = document.createElement("div");
  joybase.style.cssText =
    `position: absolute; width: ${JOY_RADIUS * 2}px; height: ${JOY_RADIUS * 2}px;` +
    `margin: ${-JOY_RADIUS}px 0 0 ${-JOY_RADIUS}px; border-radius: 50%; display: none;` +
    "pointer-events: none; background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.28);";
  const joyknob = document.createElement("div");
  joyknob.style.cssText =
    "position: absolute; left: 50%; top: 50%; width: 54px; height: 54px; margin: -27px 0 0 -27px;" +
    "border-radius: 50%; pointer-events: none; background: rgba(255,255,255,0.32);" +
    "border: 2px solid rgba(255,255,255,0.55);";
  joybase.appendChild(joyknob);
  root.appendChild(joybase);

  const moveHint = showMoveHint(root);

  const st = noa.inputs.state as Record<string, boolean>;
  let moveId = -1;
  const center = { x: 0, y: 0 };
  let lookId = -1;
  let lookX = 0;
  let lookY = 0;

  const clearMove = (): void => {
    st.forward = st.backward = st.left = st.right = st.sprint = false;
  };

  const setJoy = (dx: number, dy: number): void => {
    const dist = Math.hypot(dx, dy);
    const clamp = dist > JOY_RADIUS ? JOY_RADIUS / dist : 1;
    const kx = dx * clamp;
    const ky = dy * clamp;
    joyknob.style.transform = `translate(${kx}px, ${ky}px)`;
    const nx = kx / JOY_RADIUS;
    const ny = ky / JOY_RADIUS; // up is negative
    if (Math.hypot(nx, ny) < JOY_DEAD) {
      clearMove();
      return;
    }
    st.forward = ny < -JOY_DEAD;
    st.backward = ny > JOY_DEAD;
    st.left = nx < -JOY_DEAD;
    st.right = nx > JOY_DEAD;
    st.sprint = Math.hypot(nx, ny) > SPRINT_MAG;
  };

  surface.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    surface.setPointerCapture(e.pointerId);
    moveHint.armTimeout();
    const vv = window.visualViewport;
    if (e.clientX < window.innerWidth * MOVE_SIDE_FRACTION && moveId === -1) {
      moveHint.dismiss();
      moveId = e.pointerId;
      center.x = e.clientX;
      center.y = e.clientY;
      joybase.style.left = `${e.clientX - (vv?.offsetLeft ?? 0)}px`;
      joybase.style.top = `${e.clientY - (vv?.offsetTop ?? 0)}px`;
      joybase.style.display = "block";
      joyknob.style.transform = "translate(0, 0)";
    } else if (lookId === -1) {
      lookId = e.pointerId;
      lookX = e.clientX;
      lookY = e.clientY;
    }
  });

  surface.addEventListener("pointermove", (e: PointerEvent) => {
    if (e.pointerId === moveId) {
      setJoy(e.clientX - center.x, e.clientY - center.y);
      return;
    }
    if (e.pointerId !== lookId) {
      return;
    }
    const coalesced = e.getCoalescedEvents?.() ?? [];
    const list = coalesced.length > 0 ? coalesced : [e];
    let dx = 0;
    let dy = 0;
    for (const ev of list) {
      dx += ev.clientX - lookX;
      dy += ev.clientY - lookY;
      lookX = ev.clientX;
      lookY = ev.clientY;
    }
    noa.inputs.pointerState.dx += dx * LOOK_SENS_X;
    noa.inputs.pointerState.dy += dy * LOOK_SENS_Y;
  });

  const end = (e: PointerEvent): void => {
    if (e.pointerId === moveId) {
      moveId = -1;
      clearMove();
      joybase.style.display = "none";
    } else if (e.pointerId === lookId) {
      lookId = -1;
    }
  };
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);
}

/*
 *      Action buttons
 */
type ButtonSpec = {
  /** lucide path data, drawn at ~45% of the button diameter */
  icon: string;
  /** accessible name (the old text label) */
  label: string;
  bg: string;
  size: number;
  pos: string;
};

function makeButton(parent: HTMLElement, spec: ButtonSpec): HTMLDivElement {
  const el = document.createElement("div");
  el.role = "button";
  el.ariaLabel = spec.label;
  el.innerHTML = svgIcon(spec.icon, Math.round(spec.size * 0.45));
  el.style.cssText =
    `position: absolute; ${spec.pos} width: ${spec.size}px; height: ${spec.size}px;` +
    "border-radius: 50%; display: flex; align-items: center; justify-content: center;" +
    `color: #fff; background: ${spec.bg}; border: 2px solid rgba(255,255,255,0.32);` +
    "box-shadow: 0 2px 6px rgba(0,0,0,0.4); pointer-events: auto; touch-action: none;" +
    "user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;";
  parent.appendChild(el);
  return el;
}

// hold-to-press: `on` fires on press, `off` on release/cancel. setPointerCapture
// keeps the release bound to the button; stopPropagation keeps the press from
// also reaching the look/joystick surface beneath it.
function onHold(el: HTMLElement, on: () => void, off: () => void): void {
  el.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.style.transform = "scale(0.92)";
    on();
  });
  const up = (e: PointerEvent): void => {
    e.preventDefault();
    el.style.transform = "";
    off();
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function onTap(el: HTMLElement, fn: () => void): void {
  onHold(el, fn, () => {});
}

// The cluster floats above the hotbar: scaled to fit, the hotbar spans nearly
// the full width of a portrait phone (9 slots ≈ 480px natural), with its top
// edge around 52px up — so every button keeps `bottom` ≥ 64px to clear it.
function setupActionButtons(noa: Engine, root: HTMLElement, opts: MobileControlOptions): void {
  const st = noa.inputs.state as Record<string, boolean>;
  const safeR = "env(safe-area-inset-right)";
  const safeB = "env(safe-area-inset-bottom)";

  // BREAK / ATTACK (big, corner) — hold to keep mining; emitting fire down/up
  // also drives bow draw + release. The client's 80ms repeat watches state.fire.
  const breakBtn = makeButton(root, {
    icon: ICON_PICKAXE,
    label: "Break / attack",
    bg: "rgba(200,64,64,0.5)",
    size: 92,
    pos: `right: calc(16px + ${safeR}); bottom: calc(64px + ${safeB});`,
  });
  onHold(
    breakBtn,
    () => {
      st.fire = true;
      noa.inputs.down.emit("fire");
    },
    () => {
      st.fire = false;
      noa.inputs.up.emit("fire");
    },
  );

  // JUMP / SWIM — hold to keep rising in water
  const jumpBtn = makeButton(root, {
    icon: ICON_ARROW_BIG_UP,
    label: "Jump / swim",
    bg: "rgba(70,120,210,0.5)",
    size: 68,
    pos: `right: calc(120px + ${safeR}); bottom: calc(72px + ${safeB});`,
  });
  onHold(
    jumpBtn,
    () => {
      st.jump = true;
    },
    () => {
      st.jump = false;
    },
  );

  // PLACE / USE — emits alt-fire (places held block, or opens a crafting table)
  const placeBtn = makeButton(root, {
    icon: ICON_BOX,
    label: "Place / use",
    bg: "rgba(70,170,90,0.5)",
    size: 68,
    pos: `right: calc(120px + ${safeR}); bottom: calc(152px + ${safeB});`,
  });
  onTap(placeBtn, () => noa.inputs.down.emit("alt-fire"));

  // THROW — emits mid-fire (throws the held item)
  const throwBtn = makeButton(root, {
    icon: ICON_SEND,
    label: "Throw held item",
    bg: "rgba(90,90,120,0.5)",
    size: 60,
    pos: `right: calc(30px + ${safeR}); bottom: calc(168px + ${safeB});`,
  });
  onTap(throwBtn, () => noa.inputs.down.emit("mid-fire"));

  // VIEW — first/third person toggle (the V key). Below the host shell's menu
  // strip (~44px tall at the top-left corner) so the two never overlap.
  const viewBtn = makeButton(root, {
    icon: ICON_SWITCH_CAMERA,
    label: "Toggle first/third person",
    bg: "rgba(20,20,28,0.55)",
    size: 56,
    pos: "top: calc(60px + env(safe-area-inset-top)); left: calc(12px + env(safe-area-inset-left));",
  });
  onTap(viewBtn, opts.toggleView);

  setupFullscreenButton(root);
}

/*
 *      Fullscreen button
 *
 *  Fullscreen must be a deliberate opt-in, never auto-requested. Android
 *  answers requestFullscreen with a modal "Viewing full screen — Got it"
 *  education sheet that swallows every touch until the player finds its
 *  button; auto-requesting on the first tap therefore made every session
 *  start with dead controls (verified in an Android emulator against the
 *  production shell). Tapping a labeled button instead makes the OS sheet
 *  an expected step, and the player dismisses it knowingly.
 */
function setupFullscreenButton(root: HTMLElement): void {
  const btn = makeButton(root, {
    icon: ICON_MAXIMIZE,
    label: "Toggle fullscreen",
    bg: "rgba(20,20,28,0.55)",
    size: 56,
    pos: "top: calc(196px + env(safe-area-inset-top)); left: calc(12px + env(safe-area-inset-left));",
  });
  onTap(btn, () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", () => {
    const icon = document.fullscreenElement ? ICON_MINIMIZE : ICON_MAXIMIZE;
    btn.innerHTML = svgIcon(icon, Math.round(56 * 0.45));
  });
}

/*
 *      Hotbar
 *
 *  Move the HUD hotbar into the viewport-tracked overlay (so it sits in the
 *  visible rect), scale it to fit the visible width (never up past 1, so the
 *  slots stay as big as the screen allows — a fixed shrink made them
 *  needlessly small in landscape), and make each slot tappable.
 */
function attachHotbar(root: HTMLElement, opts: MobileControlOptions): void {
  root.appendChild(opts.hotbarEl);
  opts.hotbarEl.style.transformOrigin = "bottom center";
  opts.hotbarEl.style.bottom = "calc(12px + env(safe-area-inset-bottom))";
  const fit = (): void => {
    const width = window.visualViewport?.width ?? window.innerWidth;
    // offsetWidth is the natural layout width — transforms don't affect it
    const natural = opts.hotbarEl.offsetWidth;
    const scale = natural > 0 ? Math.min(1, (width - 16) / natural) : 1;
    opts.hotbarEl.style.transform = `translateX(-50%) scale(${scale})`;
  };
  fit();
  window.visualViewport?.addEventListener("resize", fit);
  window.addEventListener("resize", fit);
  opts.hotbarSlots.forEach((slot, i) => {
    slot.root.style.pointerEvents = "auto";
    slot.root.style.cursor = "pointer";
    slot.root.addEventListener("click", () => opts.selectSlot(i));
  });
}

/*
 *      Inventory button
 *
 *  Lives in the same viewport-tracked overlay as the rest of the touch controls
 *  so the inventory backdrop (z 20) covers and dims it while the panel is open.
 *  The panel close button and backdrop tap handle closing on phones.
 */
function setupInventoryButton(root: HTMLElement, opts: MobileControlOptions): void {
  // stacked under the VIEW button in the left column (which itself sits below
  // the host shell's top-left menu strip)
  const el = makeButton(root, {
    icon: ICON_BACKPACK,
    label: "Inventory",
    bg: "rgba(20,20,28,0.55)",
    size: 56,
    pos: "top: calc(128px + env(safe-area-inset-top)); left: calc(12px + env(safe-area-inset-left));",
  });
  onTap(el, opts.openInventory);
}
