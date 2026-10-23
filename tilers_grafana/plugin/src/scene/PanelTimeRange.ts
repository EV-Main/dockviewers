// A panel's `timeFrom` / `timeShift` over the dashboard range: the override half of Grafana core's
// `PanelTimeRange`, which Scenes does not export.

import { dateMath, getDefaultTimeRange, rangeUtil, TimeRange } from '@grafana/data';
import { sceneGraph, SceneTimeRangeLike, SceneTimeRangeState, SceneTimeRangeTransformerBase, VariableDependencyConfig } from '@grafana/scenes';

interface PanelTimeRangeState extends SceneTimeRangeState {
  timeFrom?: string;
  timeShift?: string;
}

export class PanelTimeRange extends SceneTimeRangeTransformerBase<PanelTimeRangeState> implements SceneTimeRangeLike {
  public constructor(state: Omit<PanelTimeRangeState, 'from' | 'to' | 'value'>) {
    super({ ...state, from: 'now-6h', to: 'now', value: getDefaultTimeRange() }); // placeholders until activation
    this.addActivationHandler(() => {
      const value = this.override(this.getAncestorTimeRange().state.value);
      this.setState({ value, from: value.raw.from.toString(), to: value.raw.to.toString() });
    });
  }

  protected _variableDependency = new VariableDependencyConfig(this, { statePaths: ['timeFrom', 'timeShift'] });

  protected ancestorTimeRangeChanged(ancestor: SceneTimeRangeState): void {
    this.setState({ value: this.override(ancestor.value) });
  }

  private override(parent: TimeRange): TimeRange {
    let range = parent;
    if (this.state.timeFrom) {
      const from = rangeUtil.describeTextRange(sceneGraph.interpolate(this, this.state.timeFrom));
      if (from.invalid) {
        throw new Error(`invalid timeFrom ${JSON.stringify(this.state.timeFrom)}`);
      }
      if (rangeUtil.isRelativeTimeRange(parent.raw)) {
        const timezone = this.getTimeZone();
        range = {
          from: dateMath.toDateTime(from.from, { timezone })!,
          to: dateMath.toDateTime(from.to, { timezone })!,
          raw: { from: from.from, to: from.to },
        };
      }
    }
    if (this.state.timeShift) {
      const shift = sceneGraph.interpolate(this, this.state.timeShift);
      if (rangeUtil.describeTextRange(shift).invalid) {
        throw new Error(`invalid timeShift ${JSON.stringify(this.state.timeShift)}`);
      }
      const from = dateMath.parseDateMath('-' + shift, range.from, false)!;
      const to = dateMath.parseDateMath('-' + shift, range.to, true)!;
      range = { from, to, raw: { from, to } };
    }
    return range;
  }
}
