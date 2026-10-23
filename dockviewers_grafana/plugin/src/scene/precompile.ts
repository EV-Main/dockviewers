// A `dock.precompile` panel's content has a natural size: measured once in its own slot, then cached
// per browser until the panel's JSON, the root font or the plugin changes.

import { LoadingState } from '@grafana/data';
import { config } from '@grafana/runtime';
import { sceneGraph, VizPanel } from '@grafana/scenes';

import pluginJson from '../plugin.json';

export interface Precompile {
  /** `localStorage` key. */
  store: string;
  /** Hash of the panel's save model, minus `gridPos`. */
  model: string;
}

export interface Size {
  w: number;
  h: number;
}

/** Past this the content has no natural size, and `precompile` was the wrong flag. */
const MAX_PX = 4000;
/** Grafana's panel ResizeObserver re-renders a frame or two after the slot changes size. */
const PROBE_FRAMES = 3;

function stamp(p: Precompile): string {
  const version = config.apps[pluginJson.id]?.version;
  if (!version) {
    throw new Error(`${pluginJson.id} is not in Grafana's app config, so its compiled sizes can't be versioned`);
  }
  return `${p.model}:${getComputedStyle(document.documentElement).fontSize}:${version}`;
}

/** The cached size, if it was compiled for exactly this panel, font and plugin. */
export function cached(p: Precompile): Size | undefined {
  const raw = localStorage.getItem(p.store);
  if (raw === null) {
    return undefined;
  }
  const hit = JSON.parse(raw);
  if (typeof hit?.w !== 'number' || typeof hit?.h !== 'number' || typeof hit?.key !== 'string') {
    console.error(`dockviewers_grafana: compiled size at ${p.store} is unusable (${raw}); recompiling`);
    return undefined;
  }
  return hit.key === stamp(p) ? { w: hit.w, h: hit.h } : undefined;
}

/** Measure the least box `panel`'s content fits in without overflowing, then cache it. */
export async function compile(p: Precompile, panel: VizPanel, slot: HTMLElement, signal: AbortSignal): Promise<Size> {
  await visible(slot, signal);
  await loaded(panel, signal);
  const saved = slot.style.cssText;
  slot.style.overflow = 'hidden';
  try {
    const fits = async (w: number, h: number) => {
      slot.style.width = `${w}px`;
      slot.style.height = `${h}px`;
      for (let i = 0; i < PROBE_FRAMES; i++) {
        await new Promise(requestAnimationFrame);
      }
      signal.throwIfAborted();
      return !overflowed(slot);
    };
    let base = slot.clientWidth;
    if (!(await fits(base, MAX_PX))) {
      base = MAX_PX;
      if (!(await fits(base, MAX_PX))) {
        throw new Error(`${panel.state.key} overflows even a ${MAX_PX}px box: its content has no natural size to precompile`);
      }
    }
    const h = await least(MAX_PX, (h) => fits(base, h));
    const w = await least(base, (w) => fits(w, h));
    localStorage.setItem(p.store, JSON.stringify({ key: stamp(p), w, h }));
    return { w, h };
  } finally {
    slot.style.cssText = saved;
  }
}

/** The least `x` in `[1, hi]` with `ok(x)`, given `ok(hi)` and monotone `ok`. */
async function least(hi: number, ok: (x: number) => Promise<boolean>): Promise<number> {
  let lo = 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await ok(mid)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return hi;
}

/** Some box in `slot` clips content: the slot itself, or any descendant that doesn't let it spill. */
function overflowed(slot: HTMLElement): boolean {
  const over = (e: Element) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1;
  if (over(slot)) {
    return true;
  }
  for (const e of slot.querySelectorAll('*')) {
    const s = getComputedStyle(e);
    if ((s.overflowX !== 'visible' || s.overflowY !== 'visible') && over(e)) {
      return true;
    }
  }
  return false;
}

/** `LazyLoader` renders the panel only once its slot is on screen. */
function visible(slot: HTMLElement, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        done();
      }
    });
    io.observe(slot);
    signal.addEventListener('abort', () => {
      io.disconnect();
      fail(signal.reason);
    });
  });
}

function loaded(panel: VizPanel, signal: AbortSignal): Promise<void> {
  if (!panel.state.$data) {
    return Promise.resolve();
  }
  const data = sceneGraph.getData(panel);
  return new Promise((done, fail) => {
    const check = () => {
      if (data.state.data?.state === LoadingState.Done) {
        sub.unsubscribe();
        done();
      }
    };
    const sub = data.subscribeToState(check);
    check();
    signal.addEventListener('abort', () => {
      sub.unsubscribe();
      fail(signal.reason);
    });
  });
}
