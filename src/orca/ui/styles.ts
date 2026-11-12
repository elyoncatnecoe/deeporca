/*
 * Chrome 61 is the compatibility floor (Android 8.1's factory WebView, which is
 * what the Xiaohongshu minitool container runs on). Three constructs used below
 * are newer than that and are written as "baseline first, modern second":
 *
 *   - `env(safe-area-inset-*)` is Chrome 69+. Rather than repeat every rule,
 *     the insets are folded into four `--safe-*` variables that default to 0px
 *     and are only raised inside an `@supports` block. Two reasons for the
 *     indirection:
 *       1. `env()` on its own would invalidate the declaration at parse time on
 *          61, which is why the plain value has to come first everywhere.
 *       2. The PC simulator does not produce real insets — it injects
 *          `--safe-area-inset-*` variables to emulate the notch. Reading the
 *          variable first, with `env()` as the fallback, is what makes the
 *          same rule correct in the simulator *and* on a device.
 *     `var()` itself is Chrome 49, so the usage sites are safe on 61: they
 *     resolve against the 0px defaults.
 *   - flex `gap` is Chrome 84+. Each gapped container gets a `> * + *`
 *     child-margin baseline, and the `.supports-flex-gap` class (set by the
 *     boot script after measuring real Flex layout) switches it back to `gap`.
 *   - `inset`, `min()`/`clamp()` are Chrome 87/79. They are spelled out with
 *     physical properties and a media-query step instead.
 *
 * Grid `gap` is Chrome 57, so the grid branch below uses `grid-gap` directly.
 */
export const ORCA_CSS = `
:root {
  --orca-accent: #dc7759;
  --orca-accent-soft: #f4e3d8;
  --orca-panel: #f2eee9;
  --orca-panel-border: #e0d5c5;
  --orca-text: #444444;
  --orca-text-soft: #6f6a5e;
  --orca-paper: #faf7f2;
  --orca-shadow: 0 2px 6px rgba(70, 60, 45, 0.08);
  /* Zero unless the engine understands env(); see the note at the top. */
  --safe-top: 0px;
  --safe-right: 0px;
  --safe-bottom: 0px;
  --safe-left: 0px;
}
@supports (padding-top: env(safe-area-inset-top)) {
  :root {
    --safe-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
    --safe-right: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
    --safe-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
    --safe-left: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
  }
}
.orca-aquarium-root {
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.orca-shell-toggle {
  position: fixed;
  right: calc(18px + var(--safe-right));
  bottom: calc(18px + var(--safe-bottom));
  z-index: 9999;
  padding: 9px 14px; border: 1px solid var(--orca-panel-border);
  border-radius: 14px; background: var(--orca-panel); color: var(--orca-text);
  font-size: 13px; cursor: pointer; pointer-events: auto;
  box-shadow: var(--orca-shadow);
  min-height: var(--orca-tap);
  display: inline-flex; align-items: center; justify-content: center;
}
.orca-shell-toggle:hover {
  border-color: var(--orca-accent);
  background: var(--orca-paper);
  color: var(--orca-accent);
}
/* Minimum fingertip target, per Apple's and Google's 44px guidance. Declared as
   a variable so it can be raised for touch, and set on the base rules so no
   later plain rule can clobber it. */
:root { --orca-tap: 30px; }
/* The menu is a bottom-right ☰ FAB on every device (see createAquariumToolbar
   in ui/index.ts). Rationale: the bar is wider than a phone, and Chrome 61 —
   the minitool container's WebView — has no env(safe-area-inset-*) support, so
   a top-anchored bar collides with the status bar / notch. The Android nav bar
   already reserves the space below the screen, so anchoring to the bottom needs
   none of that math. The FAB shares the toolbar's visibility: hidden in ambient
   mode along with the rest of the bar. */
.orca-menu {
  position: fixed;
  right: calc(16px + var(--safe-right));
  bottom: calc(16px + var(--safe-bottom));
  z-index: 10001;
  display: flex; flex-direction: column; align-items: flex-end;
  pointer-events: none;
}
.orca-menu__trigger {
  pointer-events: auto;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: var(--orca-tap); min-height: var(--orca-tap);
  padding: 0 14px; border: 1px solid var(--orca-panel-border);
  border-radius: 14px; background: var(--orca-panel); color: var(--orca-text);
  box-shadow: var(--orca-shadow); font-size: 18px; cursor: pointer;
}
.orca-toolbar {
  /* The floating panel the FAB reveals. Hidden until .open; it floats above the
     trigger and wraps into a card on narrow screens. */
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  z-index: 2;
  display: none;
  box-sizing: border-box;
  flex-wrap: wrap; align-items: center; justify-content: flex-start;
  --g: 6px; padding: 8px; max-width: min(92vw, 360px);
  border: 1px solid var(--orca-panel-border);
  border-radius: 18px; background: var(--orca-panel);
  box-shadow: var(--orca-shadow); pointer-events: auto;
}
.orca-menu.open .orca-toolbar { display: flex; }
/* margin-gutter spacing: a half-gutter on every child yields a full gutter
   between neighbours and is wrap-safe on Chrome 61 (which has no flex gap). */
.orca-toolbar > * { margin: calc(var(--g) / 2); }
.orca-toolbar__btn {
  border: 1px solid transparent; border-radius: 12px; padding: 8px 10px;
  background: transparent; color: var(--orca-text); font-size: 13px; cursor: pointer;
  white-space: nowrap; flex: 0 0 auto;
  min-height: var(--orca-tap);
  display: inline-flex; align-items: center; justify-content: center;
}
.orca-toolbar__btn:hover {
  background: var(--orca-accent-soft);
  color: var(--orca-accent);
}
.orca-toolbar__themes {
  display: flex; --g: 5px; flex-wrap: nowrap; padding-left: 6px;
  border-left: 1px solid var(--orca-panel-border); flex: 0 0 auto;
}
.orca-toolbar__themes > * + * { margin-left: var(--g); }
.orca-toolbar__theme {
  border: 1px solid var(--orca-panel-border); border-radius: 12px;
  padding: 7px 9px; background: var(--orca-paper); color: var(--orca-text-soft);
  font-size: 12px; cursor: pointer; white-space: nowrap; flex: 0 0 auto;
  min-height: var(--orca-tap);
  display: inline-flex; align-items: center; justify-content: center;
}
.orca-toolbar__theme:hover { color: var(--orca-text); border-color: var(--orca-accent); }
.orca-toolbar__theme[data-active='true'] {
  background: var(--orca-accent-soft);
  border-color: var(--orca-accent);
  color: var(--orca-accent);
  font-weight: 600;
}
.orca-decor-picker {
  position: fixed;
  bottom: calc(24px + var(--safe-bottom));
  left: 50%; transform: translateX(-50%);
  z-index: 10000; padding: 12px 14px; border: 1px solid var(--orca-panel-border);
  border-radius: 18px; background: var(--orca-panel);
  box-shadow: var(--orca-shadow); pointer-events: auto;
  /* min() is Chrome 79; the 720px cap only matters on a wide viewport, so it
     is applied by a media query instead of by the function. border-box so the
     padding and border stay inside the cap rather than adding 30px to it. */
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
}
@media (min-width: 744px) {
  .orca-decor-picker { max-width: 720px; }
}
.orca-decor-picker__head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.orca-decor-picker__title { flex: 1 1 auto; min-width: 0; color: var(--orca-text-soft); font-size: 12px; }
.orca-decor-picker__close {
  flex: 0 0 auto; width: 30px; height: 30px; padding: 0; border-radius: 50%;
  border: 1px solid var(--orca-panel-border); background: var(--orca-paper);
  color: var(--orca-text); font-size: 18px; line-height: 1; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  min-height: var(--orca-tap);
}
.orca-decor-picker__close:hover { border-color: var(--orca-accent); color: var(--orca-accent); }
.orca-decor-picker__row { display: flex; --g: 8px; flex-wrap: wrap; }
.orca-decor-picker__row > * + * { margin-left: var(--g); }
.orca-decor-picker__chip {
  border: 1px solid var(--orca-panel-border); border-radius: 12px;
  padding: 7px 10px; background: var(--orca-paper); color: var(--orca-text);
  font-size: 12px; cursor: pointer;
  min-height: var(--orca-tap);
  display: inline-flex; align-items: center; justify-content: center;
}
.orca-decor-picker__chip:hover,
.orca-decor-picker__chip[data-active='true'] {
  border-color: var(--orca-accent);
  background: var(--orca-accent-soft);
  color: var(--orca-accent);
}
.orca-decor-picker__glow {
  display: flex; align-items: center; --g: 10px; margin-top: 10px;
  padding-top: 10px; border-top: 1px solid var(--orca-panel-border);
}
.orca-decor-picker__glow > * + * { margin-left: var(--g); }
.orca-decor-picker__skins {
  display: flex; align-items: center; --g: 8px; flex-wrap: wrap;
  margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--orca-panel-border);
}
.orca-decor-picker__skins > * + * { margin-left: var(--g); }
.orca-decor-picker__skin-swatch {
  display: inline-block; width: 18px; height: 18px; border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.14); margin-right: 6px; vertical-align: middle;
}
.orca-decor-picker__glow-label { color: var(--orca-text-soft); font-size: 12px; white-space: nowrap; }
.orca-decor-picker__glow-value {
  min-width: 36px; text-align: right; color: var(--orca-text);
  font-size: 12px; font-variant-numeric: tabular-nums;
}
.orca-decor-picker__glow-slider {
  flex: 1; min-width: 140px; accent-color: var(--orca-accent); cursor: pointer;
}
/* Rotation is a wheel gesture on desktop and these buttons on touch. */
.orca-decor-picker__rotate {
  min-width: 38px; font-size: 15px; line-height: 1.1;
  padding: 5px 10px; font-weight: 600;
}
/* Touch: raise the fingertip minimum to the 44px both Apple and Google
   recommend, and give the fixed bars a little more clearance.
   NOTE: keep this block FLAT. Chromium does not honour a @media nested inside
   another @media, so any nesting here silently does nothing. */
@media (pointer: coarse) {
  :root { --orca-tap: 44px; }
  .orca-toolbar { --g: 6px; padding: 6px; border-radius: 16px; }
  .orca-toolbar__btn { padding: 8px 12px; font-size: 13px; }
  .orca-toolbar__theme { padding: 8px 11px; }
  .orca-decor-picker { bottom: calc(10px + var(--safe-bottom)); padding: 10px 12px; }
  .orca-decor-picker__chip { padding: 8px 12px; font-size: 13px; }
  .orca-decor-picker__glow-slider { min-width: 96px; }
  .orca-decor-picker__row { --g: 6px; }
  .orca-photo-gallery { bottom: calc(10px + var(--safe-bottom)); }
  .orca-photo-modal__btn { padding: 10px 18px; font-size: 14px; min-height: var(--orca-tap); }
  .orca-photo-gallery__thumb { width: 58px; height: 68px; }
  /* No hover on touch, so the delete affordance must always be reachable. */
  .orca-photo-gallery__del { display: block; width: 22px; height: 22px; }
}

/* Short viewports (a phone in landscape). The toolbar and the decor picker
   together would otherwise eat most of the height, so they are slimmed and the
   photo strip is lifted out of the way. Kept flat for the same reason as above. */
@media (max-height: 460px) {
  .orca-toolbar { padding: 3px 6px; --g: 4px; }
  .orca-toolbar__btn { padding: 5px 9px; font-size: 12px; }
  .orca-toolbar__theme { padding: 5px 8px; font-size: 11px; }
  .orca-decor-picker { padding: 7px 9px; }
  .orca-decor-picker__title { display: none; }
  .orca-decor-picker__row { --g: 5px; }
  .orca-decor-picker__glow,
  .orca-decor-picker__skins { margin-top: 6px; padding-top: 6px; }
  .orca-photo-gallery { display: none !important; }
  .orca-decor-picker__skin-name { display: none; }
  .orca-decor-picker__skin-swatch { width: 22px; height: 22px; margin-right: 0; }
}

/* Narrow screens (a phone in portrait). The decor picker's flex-wrap turned
   into a ragged tower — orphaned rotate buttons, one skin chip per row — that
   covered half the screen. A 4-column grid pins the decor chips into three
   tidy rows, and the skin chips drop their text labels (the two-tone swatch
   is the identity) so five skins fit on one line. */
@media (max-width: 560px) {
  .orca-decor-picker { max-height: 52vh; overflow-y: auto; overscroll-behavior: contain; }
  /* Grid, not flex-wrap, at this width. grid-gap is Chrome 57, so this
     branch needs no margin baseline — but the flex one has to be cancelled or
     every cell after the first would be inset. */
  .orca-decor-picker__row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    --g: 6px;
    gap: var(--g);
    grid-gap: var(--g);
  }
  .orca-decor-picker__row > * + * { margin-left: 0; }
  .orca-decor-picker__chip { padding: 8px 4px; font-size: 12px; }
  .orca-decor-picker__rotate { min-width: 0; }
  .orca-decor-picker__skin-name { display: none; }
  .orca-decor-picker__skin-swatch { width: 22px; height: 22px; margin-right: 0; }
  .orca-decor-picker__skins { --g: 6px; }
}
.orca-toast {
  position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%);
  z-index: 10001; padding: 8px 14px; border-radius: 999px;
  border: 1px solid var(--orca-panel-border);
  background: var(--orca-panel); color: var(--orca-text); font-size: 13px;
  pointer-events: none; opacity: 0; transition: opacity 0.25s ease;
}
.orca-toast[data-show='true'] { opacity: 1; }

/* Photo flash overlay */
.orca-photo-flash {
  position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 9998;
  background: var(--orca-paper); opacity: 0; pointer-events: none;
  transition: opacity 0.09s ease-out;
}
.orca-photo-flash[data-active='true'] { opacity: 0.68; transition: opacity 0.03s ease-in; }
.orca-photo-flash[data-tone='gold'] { background: #ffe9a8; }

/* Thought bubble (paper-flat) */
.orca-thought {
  position: fixed; z-index: 10003; max-width: 228px;
  padding: 9px 14px; border-radius: 14px;
  background: var(--orca-paper); color: var(--orca-text);
  border: 1.5px solid var(--orca-panel-border);
  box-shadow: 0 4px 14px rgba(70, 60, 45, 0.18);
  font-size: 13px; line-height: 1.45; pointer-events: none;
  opacity: 0; transform: translateY(8px) scale(0.9);
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  white-space: nowrap;
}
.orca-thought::after {
  content: ''; position: absolute; bottom: -9px; left: 24px;
  border-left: 8px solid transparent; border-right: 8px solid transparent;
  border-top: 10px solid var(--orca-paper);
}
.orca-thought[data-show='true'] {
  opacity: 1; transform: translateY(0) scale(1);
}

/* DOM bubble burst (flat rings) */
.orca-dom-bubble {
  position: fixed; z-index: 10002; border-radius: 50%;
  border: 2px solid rgba(220, 240, 255, 0.9);
  background: transparent; pointer-events: none;
  animation: orca-bubble-rise 1.1s ease-out forwards;
}
@keyframes orca-bubble-rise {
  0% { transform: translateY(0) scale(0.6); opacity: 0.9; }
  100% { transform: translateY(-72px) scale(1.15); opacity: 0; }
}


/* Photo gallery */
.orca-photo-gallery {
  position: fixed;
  bottom: calc(16px + var(--safe-bottom));
  left: 50%; transform: translateX(-50%);
  z-index: 10000; display: flex; align-items: center; --g: 10px;
  padding: 8px 10px; border: 1px solid var(--orca-panel-border);
  border-radius: 18px; background: var(--orca-panel);
  box-shadow: var(--orca-shadow); pointer-events: auto;
  max-width: calc(100vw - 24px);
}
.orca-photo-gallery > * + * { margin-left: var(--g); }
.orca-photo-gallery__label {
  color: var(--orca-text-soft); font-size: 12px; white-space: nowrap;
  letter-spacing: 0.3px;
}
.orca-photo-gallery__scroll {
  display: flex; --g: 8px; overflow-x: auto; overflow-y: hidden;
  scroll-behavior: smooth; max-width: 56vw; padding: 4px 2px;
  -webkit-overflow-scrolling: touch;
}
.orca-photo-gallery__scroll > * + * { margin-left: var(--g); }
.orca-photo-gallery__scroll::-webkit-scrollbar { height: 4px; }
.orca-photo-gallery__scroll::-webkit-scrollbar-thumb {
  background: rgba(160, 140, 120, 0.45); border-radius: 4px;
}
.orca-photo-gallery__thumb {
  position: relative; flex-shrink: 0; width: 54px; height: 62px;
  border: 1.5px solid var(--orca-panel-border); border-radius: 10px;
  background: var(--orca-paper); cursor: pointer; overflow: hidden;
  padding: 0; box-shadow: 0 1px 4px rgba(70, 60, 45, 0.10);
  transition: transform 0.18s ease, border-color 0.18s ease;
}
.orca-photo-gallery__thumb:hover {
  transform: translateY(-2px);
  border-color: var(--orca-accent);
}
.orca-photo-gallery__thumb[data-quality='perfect'],
.orca-photo-gallery__thumb[data-quality='closeup'] {
  border-color: #f2c14e;
}
/* A shaken shot: dashed border so it reads as spoiled even at thumbnail size. */
.orca-photo-gallery__thumb[data-blurry='true'] {
  border-style: dashed;
  border-color: #b9b2a4;
}
.orca-photo-gallery__thumb-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.orca-photo-gallery__badge {
  position: absolute; top: 2px; left: 2px; font-size: 11px;
  background: var(--orca-paper); border-radius: 5px; padding: 0 3px;
  line-height: 1.2; pointer-events: none;
}
.orca-photo-gallery__del {
  position: absolute; top: 2px; right: 2px; width: 16px; height: 16px;
  border: 1px solid var(--orca-panel-border); border-radius: 50%;
  background: var(--orca-paper); color: var(--orca-text-soft);
  font-size: 11px; line-height: 1; cursor: pointer; padding: 0;
  display: none;
}
.orca-photo-gallery__thumb:hover .orca-photo-gallery__del { display: block; }
.orca-photo-gallery__del:hover { color: var(--orca-accent); border-color: var(--orca-accent); }

/* Photo modal */
.orca-photo-modal {
  position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10002;
  background: rgba(24, 22, 18, 0.48);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; pointer-events: none; transition: opacity 0.25s ease;
}
.orca-photo-modal[data-active='true'] { opacity: 1; pointer-events: auto; }
.orca-photo-modal__panel {
  position: relative; background: var(--orca-panel);
  border: 1px solid var(--orca-panel-border); border-radius: 18px;
  padding: 16px 16px 18px; max-width: 84vw; max-height: 84vh;
  display: flex; flex-direction: column; align-items: center; --g: 10px;
  box-shadow: 0 12px 30px rgba(30, 25, 18, 0.22);
}
/* :not() keeps the close button out of the spacing baseline: it is absolutely
   positioned, so a margin-top would offset it away from its top: 8px. */
.orca-photo-modal__panel > * + *:not(.orca-photo-modal__close) { margin-top: var(--g); }
.orca-photo-modal__close {
  position: absolute; top: 8px; right: 12px; font-size: 22px;
  cursor: pointer; color: var(--orca-text-soft); background: none; border: none;
  line-height: 1;
}
.orca-photo-modal__close:hover { color: var(--orca-text); }
.orca-photo-modal__img {
  max-width: 72vw; max-height: 58vh; border-radius: 10px;
  border: 1px solid var(--orca-panel-border);
  /* Keep the long-press "save image" callout working on mobile webviews. */
  -webkit-touch-callout: default;
  -webkit-user-select: auto; user-select: auto;
}
.orca-photo-modal__caption { color: var(--orca-text-soft); font-size: 13px; }
.orca-photo-modal__hint {
  color: var(--orca-text-soft); font-size: 12px; opacity: 0.85; text-align: center;
}
.orca-photo-modal__actions { display: flex; --g: 8px; }
.orca-photo-modal__actions > * + * { margin-left: var(--g); }
.orca-photo-modal__btn {
  border: 1px solid var(--orca-panel-border); border-radius: 12px;
  padding: 7px 14px; background: var(--orca-paper); color: var(--orca-text);
  font-size: 13px; cursor: pointer;
}
.orca-photo-modal__btn:hover {
  border-color: var(--orca-accent);
  color: var(--orca-accent);
  background: var(--orca-accent-soft);
}

/* Fatal fallback: shown when WebGL is unavailable or was lost. */
.orca-fatal {
  position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10010;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  --g: 14px; padding: 32px 24px; text-align: center;
  background: #0d3a50; color: #eaf4f8;
}
.orca-fatal > * + * { margin-top: var(--g); }
.orca-fatal__title { font-size: 18px; font-weight: 600; }
.orca-fatal__body { font-size: 14px; line-height: 1.7; max-width: 30em; opacity: 0.85; }
.orca-fatal__retry {
  margin-top: 6px; padding: 11px 26px; border: 0; border-radius: 999px;
  background: var(--orca-paper, #f2eee9); color: #0d3a50;
  font-size: 15px; font-weight: 600; cursor: pointer;
}
.orca-fatal__retry:hover { background: #ffffff; }

/* Enhancement layer. The boot script only adds this class after it has
   measured a real flex box, so gap below is known to work on flex.
   The ordering matters: the child margins above are the DEFAULT, not a
   fallback — gap is added here, never subtracted. If this class never lands
   (old WebView, or the boot script itself failed), spacing is still correct at
   the margin baseline rather than doubled. */
.supports-flex-gap .orca-toolbar,
.supports-flex-gap .orca-toolbar__themes,
.supports-flex-gap .orca-decor-picker__row,
.supports-flex-gap .orca-decor-picker__glow,
.supports-flex-gap .orca-decor-picker__skins,
.supports-flex-gap .orca-photo-gallery,
.supports-flex-gap .orca-photo-gallery__scroll,
.supports-flex-gap .orca-photo-modal__actions {
  column-gap: var(--g);
}
.supports-flex-gap .orca-photo-modal__panel,
.supports-flex-gap .orca-fatal {
  row-gap: var(--g);
}
.supports-flex-gap .orca-toolbar > * + *,
.supports-flex-gap .orca-toolbar__themes > * + *,
.supports-flex-gap .orca-decor-picker__row > * + *,
.supports-flex-gap .orca-decor-picker__glow > * + *,
.supports-flex-gap .orca-decor-picker__skins > * + *,
.supports-flex-gap .orca-photo-gallery > * + *,
.supports-flex-gap .orca-photo-gallery__scroll > * + *,
.supports-flex-gap .orca-photo-modal__actions > * + * {
  margin-left: 0;
}
.supports-flex-gap .orca-photo-modal__panel > * + *:not(.orca-photo-modal__close) {
  margin-top: 0;
}
.supports-flex-gap .orca-fatal > * + * {
  margin-top: 0;
}
`

let styleInjected = false

export function injectOrcaStyles(): void {
  if (styleInjected || typeof document === 'undefined') return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@elyoncat/orca-aquarium-shell'
  tag.textContent = ORCA_CSS
  document.head.appendChild(tag)
  styleInjected = true
}
