import { useDevelop } from '../../state/develop';
import { BasicPanel } from './Basic';
import { ColorGradingPanel } from './ColorGrading';
import { ColorMixerPanel } from './ColorMixer';
import { CropPanel } from './CropPanel';
import { DetailPanel, EffectsPanel, LensPanel } from './DetailPanels';
import { Histogram } from './Histogram';
import { MasksPanel } from './MasksPanel';
import { SelectPanel } from './SelectPanel';
import { SpotsPanel } from './SpotsPanel';
import { ToneCurvePanel } from './ToneCurve';

export function DevelopRight() {
  const tool = useDevelop((s) => s.tool);
  const view = useDevelop((s) => s.view);
  const st = useDevelop.getState;
  const source = useDevelop((s) => s.source);
  return (
    <>
      <Histogram />
      <div className="tool-strip">
        <button className={tool === 'crop' ? 'active' : ''} title="Crop & straighten (R)" onClick={() => st().setTool('crop')}>
          ⌗<span>Crop</span>
        </button>
        <button className={tool === 'spots' ? 'active' : ''} title="Spot removal (Q)" onClick={() => st().setTool('spots')}>
          ✚<span>Spots</span>
        </button>
        <button className={tool === 'masks' ? 'active' : ''} title="Masks (M)" onClick={() => st().setTool('masks')}>
          ◑<span>Masks</span>
        </button>
        <button className={tool === 'select' ? 'active' : ''} title="Select (S)" onClick={() => st().setTool('select')}>
          ◇<span>Select</span>
        </button>
        <button className={tool === 'wb' ? 'active' : ''} title="White balance selector (W)" onClick={() => st().setTool('wb')}>
          ⌖<span>WB</span>
        </button>
        <button className={view.before ? 'active' : ''} title="Before / after (\)" onClick={() => st().setView({ before: !view.before })}>
          ◧<span>Before</span>
        </button>
        <button className={view.showClipping ? 'active' : ''} title="Show clipping (J)" onClick={() => st().setView({ showClipping: !view.showClipping })}>
          ◭<span>Clipping</span>
        </button>
      </div>
      {!source && <div className="panel-empty">Select a photo to edit</div>}
      {source && (
        <div className="panel-scroll">
          {tool === 'crop' && <CropPanel />}
          {tool === 'masks' && <MasksPanel />}
          {tool === 'select' && <SelectPanel />}
          {tool === 'spots' && <SpotsPanel />}
          <BasicPanel />
          <ToneCurvePanel />
          <ColorMixerPanel />
          <ColorGradingPanel />
          <DetailPanel />
          <LensPanel />
          <EffectsPanel />
        </div>
      )}
    </>
  );
}
