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
 *  Fullscreen: requests real fullscreen on the first tap (reclaims the address
 *  bar on Android) and sizes the game to the dynamic viewport. The controls are
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

/**
 * Whether to show touch controls. Auto-detects a coarse-pointer touch device;
 * override with `?touch=1` / `?touch=0` in the URL for testing on desktop.
 */
export function isTouchDevice(): boolean {
  const override = new URLSearchParams(window.location.search).get("touch");
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
  setupInventoryButton(opts);
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
  style.textContent = "#noa-container { height: 100dvh !important; bottom: auto !important; }";
  document.head.appendChild(style);

  // real fullscreen on the first user gesture (Android: hides the address bar
  // and bottom toolbar entirely; iOS Safari ignores it and falls back to the
  // dvh sizing + safe-area insets + visualViewport pinning below).
  let triedFullscreen = false;
  const goFullscreen = (): void => {
    if (triedFullscreen) {
      return;
    }
    triedFullscreen = true;
    void document.documentElement.requestFullscreen?.().catch(() => {});
  };
  window.addEventListener("touchend", goFullscreen, { once: true, passive: true });
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
 *      Joystick + look on one pointer-capture surface
 */
function setupSurface(noa: Engine, root: HTMLElement): void {
  const surface = document.createElement("div");
  surface.style.cssText = "position: absolute; inset: 0; pointer-events: auto; touch-action: none;";
  root.appendChild(surface);

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
    const vv = window.visualViewport;
    if (e.clientX < window.innerWidth * MOVE_SIDE_FRACTION && moveId === -1) {
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
type ButtonSpec = { label: string; bg: string; size: number; pos: string };

function makeButton(parent: HTMLElement, spec: ButtonSpec): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = spec.label;
  el.style.cssText =
    `position: absolute; ${spec.pos} width: ${spec.size}px; height: ${spec.size}px;` +
    "border-radius: 50%; display: flex; align-items: center; justify-content: center;" +
    "text-align: center; color: #fff; font: 600 12px/1.05 system-ui, sans-serif;" +
    `background: ${spec.bg}; border: 2px solid rgba(255,255,255,0.32);` +
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

function setupActionButtons(noa: Engine, root: HTMLElement, opts: MobileControlOptions): void {
  const st = noa.inputs.state as Record<string, boolean>;
  const safeR = "env(safe-area-inset-right)";
  const safeB = "env(safe-area-inset-bottom)";

  // BREAK / ATTACK (big, corner) — hold to keep mining; emitting fire down/up
  // also drives bow draw + release. The client's 80ms repeat watches state.fire.
  const breakBtn = makeButton(root, {
    label: "BREAK",
    bg: "rgba(200,64,64,0.5)",
    size: 84,
    pos: `right: calc(22px + ${safeR}); bottom: calc(40px + ${safeB});`,
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
    label: "JUMP",
    bg: "rgba(70,120,210,0.5)",
    size: 60,
    pos: `right: calc(120px + ${safeR}); bottom: calc(46px + ${safeB});`,
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
    label: "PLACE",
    bg: "rgba(70,170,90,0.5)",
    size: 60,
    pos: `right: calc(120px + ${safeR}); bottom: calc(112px + ${safeB});`,
  });
  onTap(placeBtn, () => noa.inputs.down.emit("alt-fire"));

  // THROW — emits mid-fire (throws the held item)
  const throwBtn = makeButton(root, {
    label: "THROW",
    bg: "rgba(90,90,120,0.5)",
    size: 54,
    pos: `right: calc(180px + ${safeR}); bottom: calc(50px + ${safeB});`,
  });
  onTap(throwBtn, () => noa.inputs.down.emit("mid-fire"));

  // VIEW — first/third person toggle (the V key)
  const viewBtn = makeButton(root, {
    label: "VIEW",
    bg: "rgba(20,20,28,0.55)",
    size: 50,
    pos: "top: calc(14px + env(safe-area-inset-top)); left: calc(14px + env(safe-area-inset-left));",
  });
  onTap(viewBtn, opts.toggleView);
}

/*
 *      Hotbar
 *
 *  Move the HUD hotbar into the viewport-tracked overlay (so it sits in the
 *  visible rect), shrink it for narrow screens, and make each slot tappable.
 */
function attachHotbar(root: HTMLElement, opts: MobileControlOptions): void {
  root.appendChild(opts.hotbarEl);
  opts.hotbarEl.style.transformOrigin = "bottom center";
  opts.hotbarEl.style.transform = "translateX(-50%) scale(0.82)";
  opts.hotbarEl.style.bottom = "calc(12px + env(safe-area-inset-bottom))";
  opts.hotbarSlots.forEach((slot, i) => {
    slot.root.style.pointerEvents = "auto";
    slot.root.style.cursor = "pointer";
    slot.root.addEventListener("click", () => opts.selectSlot(i));
  });
}

/*
 *      Inventory button
 *
 *  Lives ABOVE the inventory backdrop (z 20) — unlike the rest of the overlay,
 *  which sits below it — so the same button opens and closes the inventory.
 */
function setupInventoryButton(opts: MobileControlOptions): void {
  const el = document.createElement("div");
  el.textContent = "INV";
  el.style.cssText =
    "position: fixed; z-index: 25; top: calc(14px + env(safe-area-inset-top));" +
    "left: calc(74px + env(safe-area-inset-left)); width: 50px; height: 50px;" +
    "border-radius: 50%; display: flex; align-items: center; justify-content: center;" +
    "color: #fff; font: 600 12px/1.05 system-ui, sans-serif; background: rgba(20,20,28,0.55);" +
    "border: 2px solid rgba(255,255,255,0.32); box-shadow: 0 2px 6px rgba(0,0,0,0.4);" +
    "pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;" +
    "-webkit-touch-callout: none;";
  document.body.appendChild(el);
  onTap(el, opts.openInventory);
}
