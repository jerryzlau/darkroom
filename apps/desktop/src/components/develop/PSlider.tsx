import type { EditParams } from '@darkroom/core';
import { useDevelop } from '../../state/develop';
import { Slider, type SliderProps } from '../ui';

const signed = (d = 0) => (v: number) => (v > 0 ? '+' : '') + v.toFixed(d);

/** A slider bound to a field of the open image's EditParams. */
export function PSlider(
  props: Omit<SliderProps, 'value' | 'onChange' | 'onCommit'> & {
    get: (p: EditParams) => number;
    set: (p: EditParams, v: number) => void;
    commitLabel?: string;
    signedDigits?: number;
  },
) {
  const value = useDevelop((s) => props.get(s.params));
  const update = useDevelop((s) => s.update);
  const commit = useDevelop((s) => s.commit);
  const { get: _g, set, commitLabel, signedDigits, ...rest } = props;
  void _g;
  return (
    <Slider
      {...rest}
      format={rest.format ?? (signedDigits !== undefined ? signed(signedDigits) : undefined)}
      value={value}
      onChange={(v) => update((p) => set(p, v))}
      onCommit={() => commit(commitLabel ?? props.label)}
    />
  );
}

export const fmtSigned = signed;
