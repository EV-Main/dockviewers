import { css } from '@emotion/css';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GrafanaTheme2 } from '@grafana/data';
import { GridPos } from '@grafana/schema';
import { LazyLoader, SceneComponentProps, SceneObjectBase, SceneObjectState, VariableDependencyConfig, VizPanel } from '@grafana/scenes';
import { ContextMenu, Menu, useStyles2 } from '@grafana/ui';

import init, { Dock, mount, Seed } from '../wasm/dockviewers_grafana';
import wasm from '../wasm/dockviewers_grafana_bg.wasm';
import { cached, compile, Precompile } from './precompile';

const ready = init({ module_or_path: wasm });

/** What a panel's content needs, in CSS px (`0` = nothing beyond the chrome), or a size to compile. */
export type DockSpec = { minW: number; minH: number } | { precompile: Precompile };

interface DockLayoutState extends SceneObjectState {
  children: VizPanel[];
  /** By panel key, which is also the panel's dock id. */
  gridPos: Record<string, GridPos>;
  /** By panel key. */
  dock: Record<string, DockSpec>;
  storageKey: string;
  /** Interpolated, by panel key. */
  titles: Map<string, string>;
}

/** The dashboard body: panels laid out by the dockviewers grid, each rendered natively through a portal. */
export class DockLayout extends SceneObjectBase<DockLayoutState> {
  public static Component = DockLayoutRenderer;

  protected _variableDependency = new VariableDependencyConfig(this, { variableNames: [], onAnyVariableChanged: () => this.retitle() });

  public constructor(state: DockLayoutState) {
    super(state);
    this.addActivationHandler(() => this.retitle());
  }

  private retitle() {
    this.setState({ titles: new Map(this.state.children.map((p) => [p.state.key!, p.interpolate(p.state.title, undefined, 'text')])) });
  }
}

function DockLayoutRenderer({ model }: SceneComponentProps<DockLayout>) {
  const { children, gridPos, dock: specs, storageKey, titles } = model.useState();
  const styles = useStyles2(getStyles);
  const root = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const [dock, setDock] = useState<Dock>();
  const [slots, setSlots] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  const [menu, setMenu] = useState<{ gid: bigint; x: number; y: number }>();

  useEffect(() => {
    let live: Dock | undefined;
    let gone = false;
    ready.then(() => {
      if (gone) {
        return;
      }
      const seeds = children.map((p) => {
        const g = gridPos[p.state.key!];
        const spec = specs[p.state.key!];
        const min = 'precompile' in spec ? (cached(spec.precompile) ?? { w: 0, h: 0 }) : { w: spec.minW, h: spec.minH };
        return new Seed(p.state.key!, p.state.title, g.x!, g.y!, g.w, g.h, min.w, min.h);
      });
      live = mount(
        root.current!,
        seeds,
        storageKey,
        (id: string, el: HTMLElement) => setSlots((m) => new Map(m).set(id, el)),
        (gid: bigint) => setMenu({ gid, ...pointer.current })
      );
      setDock(live);
    });
    return () => {
      gone = true;
      live?.unmount();
    };
  }, [children, gridPos, specs, storageKey]);

  useEffect(() => {
    if (dock && titles.size) {
      dock.set_titles(titles);
    }
  }, [dock, titles]);

  // A slot is the panel's for the dock's lifetime, so each precompile miss compiles once per mount.
  const compiling = useRef(new Map<string, AbortController>());
  useEffect(() => {
    if (!dock) {
      return;
    }
    for (const p of children) {
      const key = p.state.key!;
      const spec = specs[key];
      const slot = slots.get(key);
      if (!('precompile' in spec) || !slot || compiling.current.has(key) || cached(spec.precompile)) {
        continue;
      }
      const abort = new AbortController();
      compiling.current.set(key, abort);
      compile(spec.precompile, p, slot, abort.signal).then(
        ({ w, h }) => dock.set_min(key, w, h),
        (e) => {
          if (!abort.signal.aborted) {
            throw e;
          }
        }
      );
    }
  }, [dock, children, specs, slots]);
  useEffect(() => {
    const live = compiling.current;
    return () => {
      live.forEach((a) => a.abort());
      live.clear();
    };
  }, [dock]);

  const closed = menu && dock ? children.filter((p) => !dock.hosted().includes(p.state.key!)) : [];
  return (
    <div className={styles.wrap} onPointerDownCapture={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}>
      <div ref={root} className={styles.root} />
      {children.map((p) => {
        const slot = slots.get(p.state.key!);
        return (
          slot &&
          createPortal(
            <LazyLoader key={p.state.key!} className={styles.fill}>
              <p.Component model={p} />
            </LazyLoader>,
            slot,
            p.state.key
          )
        );
      })}
      {menu && dock && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          renderMenuItems={() =>
            closed.length ? (
              closed.map((p) => (
                <Menu.Item key={p.state.key} label={titles.get(p.state.key!)!} onClick={() => dock.add_tab(menu.gid, p.state.key!)} />
              ))
            ) : (
              <Menu.Item label="Every panel is open" disabled />
            )
          }
        />
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 0,
    '--dv-group-bg': theme.colors.background.primary,
    '--dv-tabstrip-bg': theme.colors.background.secondary,
    '--dv-tab-bg': theme.colors.background.secondary,
    '--dv-tab-border': theme.colors.border.weak,
    '--dv-tab-active-bg': theme.colors.background.primary,
    '--dv-tab-active-fg': theme.colors.text.primary,
    '--dv-fg': theme.colors.text.secondary,
    '--dv-content-pad': '0',
    '.dv-grafana-slot': { width: '100%', height: '100%' },
  }),
  root: css({ position: 'absolute', inset: 0 }),
  fill: css({ width: '100%', height: '100%' }),
});
