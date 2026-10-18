// Command palette registry + search (⌘K). DOM-free and store-free so it can be
// tested in node; `lib/commandActions.ts` executes a command.

export type CommandKind = 'tool' | 'panel' | 'control' | 'action';

/** Where a command lives in the UI; the palette navigates there (see `lib/commandActions.ts`). */
export interface CommandTarget {
  module?: 'library' | 'develop';
  libView?: 'grid' | 'loupe';
  /** side panel holding `section` (opened if hidden) */
  side?: 'left' | 'right';
  /** Develop tool to activate */
  tool?: 'crop' | 'masks' | 'wb' | 'spots' | 'select';
  /** AI dock tab to open */
  aiTab?: 'chat' | 'guided' | 'generate';
  /** `Section` id (`data-section`) to open and scroll to */
  section?: string;
  /** `data-ctl` of the control inside `section` to scroll to and highlight (else the section header) */
  control?: string;
  /** needs a photo open in Develop */
  needsPhoto?: boolean;
}

export interface Command {
  id: string;
  title: string;
  /** breadcrumb, e.g. ['Develop', 'Detail', 'Sharpening'] */
  path: string[];
  kind: CommandKind;
  /** plain-language synonyms */
  keywords: string[];
  shortcut?: string;
  target?: CommandTarget;
}

/** `data-ctl` slug of a control label: "Red / Cyan fringe" → "red-cyan-fringe". */
export function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const DEV = 'Develop';
const LIB = 'Library';
const devRight = (section: string, control?: string, extra: Partial<CommandTarget> = {}): CommandTarget => ({
  module: 'develop',
  side: 'right',
  section,
  control,
  needsPhoto: true,
  ...extra,
});

const BANDS: { id: string; name: string; keywords: string[] }[] = [
  { id: 'red', name: 'Red', keywords: ['red', 'lips', 'reds'] },
  { id: 'orange', name: 'Orange', keywords: ['orange', 'skin', 'skin tone', 'face', 'tan'] },
  { id: 'yellow', name: 'Yellow', keywords: ['yellow', 'autumn', 'sand'] },
  { id: 'green', name: 'Green', keywords: ['green', 'foliage', 'grass', 'trees', 'leaves', 'plants'] },
  { id: 'aqua', name: 'Aqua', keywords: ['aqua', 'cyan', 'teal', 'water', 'sea', 'turquoise'] },
  { id: 'blue', name: 'Blue', keywords: ['blue', 'sky', 'ocean'] },
  { id: 'purple', name: 'Purple', keywords: ['purple', 'violet'] },
  { id: 'magenta', name: 'Magenta', keywords: ['magenta', 'pink'] },
];

const HSL_TABS: { id: 'hue' | 'sat' | 'lum'; name: string; keywords: string[] }[] = [
  { id: 'hue', name: 'Hue', keywords: ['hue', 'shift color', 'change color'] },
  { id: 'sat', name: 'Saturation', keywords: ['saturation', 'sat', 'intensity', 'vivid', 'desaturate'] },
  { id: 'lum', name: 'Luminance', keywords: ['luminance', 'lum', 'brightness of color', 'lighten color', 'darken color'] },
];

export function buildCommands(): Command[] {
  const out: Command[] = [];
  const add = (c: Command) => out.push(c);
  const tool = (id: string, title: string, t: NonNullable<CommandTarget['tool']>, shortcut: string, keywords: string[], section: string, control?: string) =>
    add({ id: `tool.${id}`, title, path: [DEV, 'Tools'], kind: 'tool', keywords, shortcut, target: devRight(section, control, { tool: t }) });
  const panel = (id: string, title: string, path: string[], target: CommandTarget, keywords: string[]) =>
    add({ id: `panel.${id}`, title, path, kind: 'panel', keywords, target });
  const ctl = (id: string, title: string, path: string[], target: CommandTarget, keywords: string[] = [], shortcut?: string) =>
    add({ id: `ctl.${id}`, title, path, kind: 'control', keywords, target, shortcut });
  const action = (id: string, title: string, path: string[], keywords: string[], shortcut?: string) =>
    add({ id: `action.${id}`, title, path, kind: 'action', keywords, shortcut });

  // ---------------------------------------------------------------- tools
  tool('crop', 'Crop & Straighten', 'crop', 'R', ['crop', 'straighten', 'rotate', 'level', 'horizon', 'aspect ratio', 'trim', 'cut', 'frame', 'tilt', 'flip', 'resize canvas'], 'crop');
  tool('spots', 'Spot Removal', 'spots', 'Q', ['blemish', 'mole', 'pimple', 'scar', 'acne', 'heal', 'healing brush', 'clone', 'clone stamp', 'retouch', 'dust', 'sensor dust', 'spot', 'remove spot', 'zit', 'wrinkle', 'freckle'], 'spots');
  tool('masks', 'Masks', 'masks', 'M', ['mask', 'local adjustment', 'local', 'brush', 'adjustment brush', 'gradient', 'graduated filter', 'radial', 'radial filter', 'dodge', 'burn', 'paint', 'selective edit'], 'masks');
  tool('select', 'Select', 'select', 'S', ['selection', 'lasso', 'marquee', 'rectangle', 'ellipse', 'circle', 'area', 'region', 'select area'], 'select');
  tool('wb', 'White Balance Selector', 'wb', 'W', ['eyedropper', 'dropper', 'neutral', 'gray point', 'grey point', 'white point', 'color picker', 'pick white', 'color cast', 'wb'], 'basic', 'wb');

  // ---------------------------------------------------------------- Develop right panels
  panel('basic', 'Basic', [DEV], devRight('basic'), ['basic', 'tone', 'light', 'white balance', 'presence']);
  panel('tonecurve', 'Tone Curve', [DEV], devRight('tonecurve'), ['curve', 'curves', 's-curve', 'levels', 'contrast curve', 'fade', 'matte']);
  panel('colormixer', 'Color Mixer', [DEV], devRight('colormixer'), ['hsl', 'color mixer', 'colour', 'hue saturation luminance', 'mixer', 'individual colors', 'selective color']);
  panel('bwmix', 'B&W Mix', [DEV], devRight('bwmix'), ['black and white mix', 'monochrome mix', 'channel mixer', 'grayscale mix']);
  panel('grading', 'Color Grading', [DEV], devRight('grading'), ['split toning', 'grade', 'grading', 'color wheels', 'teal and orange', 'cinematic', 'tint shadows', 'tint highlights', 'film look']);
  panel('detail', 'Detail', [DEV], devRight('detail'), ['detail', 'sharpness', 'noise reduction', 'crisp']);
  panel('lens', 'Lens Corrections', [DEV], devRight('lens'), ['lens', 'distortion', 'chromatic aberration', 'fringe', 'fringing', 'barrel', 'pincushion', 'lens profile']);
  panel('effects', 'Effects', [DEV], devRight('effects'), ['effects', 'vignette', 'grain', 'film grain', 'post-crop vignette']);

  // ---------------------------------------------------------------- Develop left panels
  const devLeft = (section: string, extra: Partial<CommandTarget> = {}): CommandTarget => ({ module: 'develop', side: 'left', section, ...extra });
  panel('nav', 'Navigator', [DEV], devLeft('nav'), ['navigator', 'overview', 'preview', 'minimap', 'zoom position']);
  panel('presets', 'Presets', [DEV], devLeft('presets'), ['presets', 'filters', 'looks', 'styles', 'lut', 'apply preset', 'apply filter', 'instagram']);
  panel('snapshots', 'Snapshots', [DEV], devLeft('snapshots'), ['snapshots', 'save state', 'versions', 'checkpoint']);
  panel('history', 'History', [DEV], devLeft('history'), ['history', 'undo list', 'steps', 'revert', 'go back', 'previous edits']);

  // ---------------------------------------------------------------- Library panels
  const libLeft = (section: string): CommandTarget => ({ module: 'library', side: 'left', section });
  panel('catalog', 'Catalog', [LIB], libLeft('catalog'), ['catalog', 'all photographs', 'all photos', 'previous import', 'edited photos', 'recent']);
  panel('folders', 'Folders', [LIB], libLeft('folders'), ['folders', 'directories', 'disk', 'location']);
  panel('collections', 'Collections', [LIB], libLeft('collections'), ['collections', 'albums', 'groups', 'sets']);
  panel('keywordlist', 'Keyword List', [LIB], libLeft('keywordlist'), ['keywords', 'tags', 'keyword list']);
  panel('lib-info', 'Metadata', [LIB], { module: 'library', side: 'right', section: 'lib-info' }, ['metadata', 'exif', 'info', 'camera', 'lens info', 'iso', 'aperture', 'shutter', 'file info', 'gps']);
  panel('lib-keywords', 'Keywording', [LIB], { module: 'library', side: 'right', section: 'lib-keywords' }, ['keywords', 'tags', 'tag photo', 'add keyword']);
  ctl('rating', 'Rating', [LIB, 'Metadata'], { module: 'library', side: 'right', section: 'lib-info', control: 'rating' }, ['stars', 'rate', 'star rating'], '0 – 5');
  ctl('flag', 'Pick / Reject Flag', [LIB, 'Metadata'], { module: 'library', side: 'right', section: 'lib-info', control: 'flag' }, ['flag', 'pick', 'reject', 'favorite', 'keep', 'cull'], 'P / X / U');

  // ---------------------------------------------------------------- Basic
  const B = [DEV, 'Basic'];
  ctl('treatment', 'Treatment (Color / B&W)', B, devRight('basic', 'treatment'), ['black and white', 'black & white', 'monochrome', 'bw', 'b&w', 'grayscale', 'greyscale', 'mono', 'colour', 'treatment']);
  ctl('wbpreset', 'White Balance Preset', B, devRight('basic', 'wb'), ['as shot', 'daylight', 'cloudy', 'shade', 'tungsten', 'fluorescent', 'flash', 'auto white balance', 'wb preset']);
  ctl('temp', 'Temp', B, devRight('basic', 'temp'), ['temperature', 'warm', 'warmer', 'cool', 'cooler', 'kelvin', 'white balance', 'yellow', 'blue', 'orange cast']);
  ctl('tint', 'Tint', B, devRight('basic', 'tint'), ['green', 'magenta', 'white balance', 'color cast', 'pink']);
  ctl('exposure', 'Exposure', [...B, 'Tone'], devRight('basic', 'exposure'), ['brightness', 'brighter', 'brighten', 'darker', 'darken', 'lighter', 'lighten', 'too dark', 'too bright', 'underexposed', 'overexposed', 'ev', 'stops', 'light']);
  ctl('contrast', 'Contrast', [...B, 'Tone'], devRight('basic', 'contrast'), ['punch', 'flat', 'pop', 'dull']);
  ctl('highlights', 'Highlights', [...B, 'Tone'], devRight('basic', 'highlights'), ['bright areas', 'recover highlights', 'blown', 'sky detail', 'hdr']);
  ctl('shadows', 'Shadows', [...B, 'Tone'], devRight('basic', 'shadows'), ['dark areas', 'lift shadows', 'open shadows', 'fill light', 'hdr']);
  ctl('whites', 'Whites', [...B, 'Tone'], devRight('basic', 'whites'), ['white point', 'brightest']);
  ctl('blacks', 'Blacks', [...B, 'Tone'], devRight('basic', 'blacks'), ['black point', 'darkest', 'crush blacks', 'deep blacks']);
  ctl('texture', 'Texture', [...B, 'Presence'], devRight('basic', 'texture'), ['skin smoothing', 'smooth skin', 'soften', 'fine detail']);
  ctl('clarity', 'Clarity', [...B, 'Presence'], devRight('basic', 'clarity'), ['midtone contrast', 'local contrast', 'crisp', 'punch', 'soft glow', 'orton']);
  ctl('dehaze', 'Dehaze', [...B, 'Presence'], devRight('basic', 'dehaze'), ['haze', 'fog', 'mist', 'smog', 'atmosphere', 'hazy']);
  ctl('vibrance', 'Vibrance', [...B, 'Presence'], devRight('basic', 'vibrance'), ['vibrant', 'colorful', 'muted colors', 'color boost']);
  ctl('saturation', 'Saturation', [...B, 'Presence'], devRight('basic', 'saturation'), ['colorful', 'desaturate', 'muted', 'vivid', 'color intensity', 'saturate']);

  // ---------------------------------------------------------------- Tone curve
  const TC = [DEV, 'Tone Curve'];
  ctl('curve', 'Point Curve', TC, devRight('tonecurve', 'curve'), ['curve', 'curves', 's-curve', 'rgb curve', 'red channel', 'green channel', 'blue channel', 'fade', 'matte', 'faded blacks']);
  for (const [k, label] of [
    ['highlights', 'Highlights'],
    ['lights', 'Lights'],
    ['darks', 'Darks'],
    ['shadows', 'Shadows'],
  ] as const)
    ctl(`curve-${k}`, `Curve ${label}`, [...TC, 'Region'], devRight('tonecurve', k), ['parametric curve', 'region curve']);
  ctl('curve-splits', 'Curve Region Splits', [...TC, 'Region'], devRight('tonecurve', 'split-1'), ['split', 'parametric curve']);

  // ---------------------------------------------------------------- Color mixer
  for (const t of HSL_TABS)
    for (const b of BANDS)
      ctl(`hsl-${t.id}-${b.id}`, `${b.name} ${t.name}`, [DEV, 'Color Mixer', t.name], devRight('colormixer', `${t.id}-${b.id}`), [...b.keywords, ...t.keywords, 'hsl', 'color mixer']);

  // ---------------------------------------------------------------- Color grading
  const CG = [DEV, 'Color Grading'];
  for (const [r, label] of [
    ['shadows', 'Shadows'],
    ['midtones', 'Midtones'],
    ['highlights', 'Highlights'],
    ['global', 'Global'],
  ] as const) {
    ctl(`grade-${r}`, `${label} Color Wheel`, CG, devRight('grading', `wheel-${r}`), ['color wheel', 'split toning', 'tint', 'grade', `tint ${r}`, `${r} color`]);
    ctl(`grade-${r}-lum`, `${label} Grading Luminance`, CG, devRight('grading', `${r}-luminance`), ['color grading luminance', `${r} brightness`]);
  }
  ctl('grade-blending', 'Grading Blending', CG, devRight('grading', 'blending'), ['blend', 'split toning blend']);
  ctl('grade-balance', 'Grading Balance', CG, devRight('grading', 'balance'), ['balance', 'split toning balance']);

  // ---------------------------------------------------------------- Detail
  const SH = [DEV, 'Detail', 'Sharpening'];
  const NR = [DEV, 'Detail', 'Noise Reduction'];
  ctl('sharpen', 'Sharpening', SH, devRight('detail', 'sharpen-amount'), ['sharpen', 'sharp', 'sharpness', 'crisp', 'blurry', 'soft', 'unsharp mask', 'focus', 'amount']);
  ctl('sharpen-radius', 'Sharpen Radius', SH, devRight('detail', 'sharpen-radius'), ['sharpen', 'radius']);
  ctl('sharpen-detail', 'Sharpen Detail', SH, devRight('detail', 'sharpen-detail'), ['sharpen', 'detail']);
  ctl('sharpen-masking', 'Sharpen Masking', SH, devRight('detail', 'sharpen-masking'), ['sharpen', 'masking', 'edge mask']);
  ctl('nr-luma', 'Luminance Noise Reduction', NR, devRight('detail', 'nr-luminance'), ['noise', 'noise reduction', 'denoise', 'grain reduction', 'reduce noise', 'remove noise', 'grainy', 'high iso', 'nr', 'smooth', 'luminance nr']);
  ctl('nr-luma-detail', 'Luminance NR Detail', NR, devRight('detail', 'nr-luminance-detail'), ['noise', 'denoise detail']);
  ctl('nr-color', 'Color Noise Reduction', NR, devRight('detail', 'nr-color'), ['color noise', 'chroma noise', 'colour noise', 'denoise', 'blotches', 'color nr']);
  ctl('nr-color-detail', 'Color NR Detail', NR, devRight('detail', 'nr-color-detail'), ['color noise', 'denoise detail']);

  // ---------------------------------------------------------------- Lens
  const LE = [DEV, 'Lens Corrections'];
  ctl('distortion', 'Distortion', LE, devRight('lens', 'distortion'), ['barrel', 'pincushion', 'lens distortion', 'fisheye', 'warp', 'bulge']);
  ctl('lens-vignetting', 'Lens Vignetting', LE, devRight('lens', 'vignetting'), ['vignette', 'dark corners', 'corner shading', 'light falloff', 'fix vignette']);
  ctl('ca-red', 'Red / Cyan Fringe', LE, devRight('lens', 'red-cyan-fringe'), ['chromatic aberration', 'fringe', 'fringing', 'ca', 'color fringe', 'purple fringe', 'defringe']);
  ctl('ca-blue', 'Blue / Yellow Fringe', LE, devRight('lens', 'blue-yellow-fringe'), ['chromatic aberration', 'fringe', 'fringing', 'ca', 'color fringe', 'purple fringe', 'defringe']);

  // ---------------------------------------------------------------- Effects
  const VG = [DEV, 'Effects', 'Post-Crop Vignetting'];
  const GR = [DEV, 'Effects', 'Grain'];
  ctl('vignette', 'Vignette', VG, devRight('effects', 'vignette-amount'), ['vignette', 'vignetting', 'dark corners', 'darken edges', 'darken corners', 'edge burn', 'spotlight', 'amount']);
  ctl('vignette-midpoint', 'Vignette Midpoint', VG, devRight('effects', 'vignette-midpoint'), ['vignette']);
  ctl('vignette-roundness', 'Vignette Roundness', VG, devRight('effects', 'vignette-roundness'), ['vignette', 'round']);
  ctl('vignette-feather', 'Vignette Feather', VG, devRight('effects', 'vignette-feather'), ['vignette', 'soft edge']);
  ctl('grain', 'Grain', GR, devRight('effects', 'grain-amount'), ['film grain', 'add grain', 'add noise', 'film look', 'analog', 'texture', 'amount']);
  ctl('grain-size', 'Grain Size', GR, devRight('effects', 'grain-size'), ['film grain']);
  ctl('grain-roughness', 'Grain Roughness', GR, devRight('effects', 'grain-roughness'), ['film grain']);

  // ---------------------------------------------------------------- Crop tool
  const CR = [DEV, 'Crop & Straighten'];
  const crop = (control: string) => devRight('crop', control, { tool: 'crop' });
  ctl('crop-aspect', 'Aspect Ratio', CR, crop('aspect'), ['aspect', 'ratio', 'square', '1:1', '4:5', '16:9', '3:2', 'portrait', 'landscape', 'instagram']);
  ctl('crop-angle', 'Straighten Angle', CR, crop('angle'), ['straighten', 'level', 'horizon', 'tilt', 'rotate', 'angle', 'crooked']);
  ctl('crop-rotate', 'Rotate 90° / Flip', CR, crop('rotate'), ['rotate', 'rotate left', 'rotate right', 'flip', 'mirror', 'flip horizontal', 'flip vertical', 'turn', 'orientation']);
  ctl('crop-actions', 'Maximize / Reset Crop', CR, crop('crop-actions'), ['reset crop', 'uncrop', 'maximize crop', 'fit crop']);

  // ---------------------------------------------------------------- Spot removal tool
  const SP = [DEV, 'Spot Removal'];
  const spots = (control: string) => devRight('spots', control, { tool: 'spots' });
  ctl('spot-mode', 'Heal / Clone Mode', SP, spots('mode'), ['heal', 'clone', 'clone stamp', 'healing']);
  ctl('spot-size', 'Spot Size', SP, spots('size'), ['brush size', 'spot radius'], '[ / ]');
  ctl('spot-feather', 'Spot Feather', SP, spots('feather'), ['soft edge', 'spot softness']);
  ctl('spot-opacity', 'Spot Opacity', SP, spots('opacity'), ['spot strength', 'spot transparency']);
  ctl('spot-actions', 'Auto Source / Clear Spots', SP, spots('spot-actions'), ['auto source', 'repick source', 'delete spot', 'clear spots', 'remove all spots']);

  // ---------------------------------------------------------------- Select tool
  const SE = [DEV, 'Selection'];
  const sel = (control: string) => devRight('select', control, { tool: 'select' });
  ctl('select-shape', 'Selection Shape', SE, sel('shape'), ['lasso', 'rectangle', 'ellipse', 'marquee', 'circle', 'freehand']);
  ctl('select-feather', 'Selection Feather', SE, sel('feather'), ['feather selection', 'soft selection', 'soften edge']);

  // ---------------------------------------------------------------- Masks tool
  const MA = [DEV, 'Masks'];
  const mask = (control?: string) => devRight('masks', control, { tool: 'masks' });
  ctl('mask-linear', 'Linear Gradient', MA, mask('add-mask'), ['graduated filter', 'gradient', 'grad', 'sky gradient', 'nd filter', 'linear mask']);
  ctl('mask-radial', 'Radial Gradient', MA, mask('add-mask'), ['radial filter', 'radial', 'circle mask', 'spotlight', 'oval mask']);
  ctl('mask-brush', 'Brush Mask', MA, mask('add-mask'), ['adjustment brush', 'brush', 'paint', 'dodge', 'burn', 'paint mask'], 'K');
  ctl('mask-range', 'Range Mask', MA, mask('range'), ['luminance range', 'color range', 'range mask', 'refine mask', 'luminosity mask']);
  ctl('mask-adjust', 'Mask Adjustments', MA, mask('adjustments'), ['local exposure', 'local contrast', 'local saturation', 'local temperature', 'local clarity', 'local dehaze', 'mask exposure', 'dodge', 'burn']);

  // ---------------------------------------------------------------- AI
  const AI = [DEV, 'AI Edit'];
  add({ id: 'ai.chat', title: 'AI Edit Chat', path: AI, kind: 'tool', keywords: ['ai', 'assistant', 'claude', 'chat', 'ask', 'describe edit', 'natural language', 'auto edit', 'prompt', 'magic'], target: devRight('ai', undefined, { aiTab: 'chat' }) });
  add({ id: 'ai.guided', title: 'Guided Edit', path: AI, kind: 'tool', keywords: ['ai', 'guided', 'options', 'suggestions', 'choose a look', 'pick a style', 'walkthrough', 'help me edit'], target: devRight('ai', undefined, { aiTab: 'guided' }) });
  add({ id: 'ai.generate', title: 'Generative Fill', path: AI, kind: 'tool', keywords: ['fill', 'generative', 'generate', 'replace', 'remove object', 'erase object', 'remove person', 'inpaint', 'content aware', 'add object', 'nano banana', 'gemini', 'ai', 'extend', 'expand'], target: devRight('ai', undefined, { aiTab: 'generate' }) });

  // ---------------------------------------------------------------- actions
  const GO = ['Navigate'];
  action('grid', 'Library Grid', GO, ['grid', 'library', 'thumbnails', 'browse', 'all photos', 'overview'], 'G');
  action('loupe', 'Loupe View', GO, ['loupe', 'single photo', 'large view', 'view photo', 'fullscreen'], 'E');
  action('develop', 'Develop', GO, ['develop', 'edit', 'edit photo', 'editor', 'adjust'], 'D');
  action('prev', 'Previous Photo', GO, ['back', 'previous', 'prev'], '←');
  action('next', 'Next Photo', GO, ['forward', 'next'], '→');
  action('fit', 'Fit to Screen', ['View'], ['fit', 'zoom out', 'whole photo', 'zoom to fit'], 'Z');
  action('zoom100', 'Zoom to 100%', ['View'], ['zoom in', 'actual pixels', '1:1', 'pixel peep', '100%'], 'Z');
  action('beforeAfter', 'Before / After', ['View'], ['before', 'after', 'compare', 'original', 'show original', 'toggle edits'], '\\');
  action('clipping', 'Show Clipping', ['View'], ['clipping', 'clipped', 'blown highlights', 'overexposed', 'underexposed', 'crushed', 'highlight warning', 'shadow warning'], 'J');
  action('togglePanels', 'Toggle Side Panels', ['View'], ['hide panels', 'show panels', 'full screen', 'distraction free', 'tab'], 'Tab');
  action('toggleLeft', 'Toggle Left Panel', ['View'], ['hide left', 'show left', 'presets panel', 'sidebar']);
  action('toggleRight', 'Toggle Right Panel', ['View'], ['hide right', 'show right', 'adjustments panel', 'sidebar']);
  action('toggleFilmstrip', 'Toggle Filmstrip', ['View'], ['filmstrip', 'hide filmstrip', 'bottom strip', 'thumbnails bar']);
  action('toggleAi', 'Toggle AI Dock', ['View'], ['ai panel', 'ai dock', 'hide ai', 'show ai'], '⌘J');

  const FILE = ['File'];
  action('importFolder', 'Import Folder…', FILE, ['import', 'add photos', 'open folder', 'load', 'add folder', 'open'], '⇧⌘I');
  action('importFiles', 'Import Files…', FILE, ['import', 'add photos', 'open file', 'load', 'add files', 'open'], '⌥⇧⌘I');
  action('export', 'Export…', FILE, ['export', 'save', 'save as', 'jpeg', 'jpg', 'tiff', 'png', 'share', 'output', 'render', 'download'], '⇧⌘E');
  action('settings', 'Settings…', ['App'], ['settings', 'preferences', 'options', 'api key', 'anthropic key', 'claude key', 'google key', 'gemini key', 'configure'], undefined);
  action('shortcuts', 'Keyboard Shortcuts', ['App'], ['keys', 'hotkeys', 'keyboard', 'help', 'cheat sheet'], '?');
  action('filterLibrary', 'Filter Library…', ['App'], ['filter library', 'manage presets', 'manage filters', 'presets', 'filters', 'looks']);

  const ED = ['Edit'];
  action('undo', 'Undo', ED, ['undo', 'step back', 'revert'], '⌘Z');
  action('redo', 'Redo', ED, ['redo', 'step forward'], '⇧⌘Z');
  action('resetAll', 'Reset All Settings', ED, ['reset', 'revert', 'original', 'start over', 'clear edits', 'remove edits', 'undo all'], '⇧⌘R');
  action('copySettings', 'Copy Settings…', ED, ['copy', 'copy edits', 'copy adjustments', 'sync settings', 'copy develop settings'], '⇧⌘C');
  action('pasteSettings', 'Paste Settings', ED, ['paste', 'paste edits', 'sync', 'apply to others', 'batch edit', 'apply to selected'], '⇧⌘V');
  action('savePreset', 'Save as Preset…', ED, ['save preset', 'create preset', 'new preset', 'save filter', 'save look', 'create filter']);
  action('snapshot', 'New Snapshot', ED, ['snapshot', 'save state', 'checkpoint', 'bookmark'], '⌘N');
  action('autoTone', 'Auto Tone', ED, ['auto', 'auto fix', 'auto adjust', 'auto exposure', 'automatic', 'one click', 'enhance', 'magic']);
  action('autoWb', 'Auto White Balance', ED, ['auto wb', 'auto white balance', 'fix color cast', 'auto color', 'automatic']);

  const PH = ['Photo'];
  action('virtualCopy', 'Create Virtual Copy', PH, ['duplicate', 'copy photo', 'version', 'virtual copy', 'clone photo'], "⌘'");
  action('selectAll', 'Select All Photos', PH, ['select all', 'all photos'], '⌘A');
  action('pick', 'Flag as Pick', PH, ['pick', 'flag', 'keep', 'favorite', 'like'], 'P');
  action('reject', 'Flag as Rejected', PH, ['reject', 'flag', 'discard', 'bad'], 'X');
  action('unflag', 'Remove Flag', PH, ['unflag', 'clear flag'], 'U');
  action('remove', 'Remove from Catalog…', PH, ['delete', 'remove', 'trash', 'remove photo'], '⌫');
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[‘’']/g, '').replace(/\s+/g, ' ').trim();
const words = (s: string) => s.split(/[^a-z0-9&%:]+/).filter(Boolean);

/** Subsequence match score in (0, 1], 0 when `q` is not a subsequence of `s`. Rewards contiguous runs and word starts. */
function fuzzy(q: string, s: string): number {
  let qi = 0;
  let score = 0;
  let run = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      run++;
      const wordStart = i === 0 || !/[a-z0-9]/.test(s[i - 1]);
      score += 1 + run + (wordStart ? 2 : 0);
      qi++;
    } else run = 0;
  }
  if (qi < q.length) return 0;
  return Math.min(1, score / (q.length * 4));
}

/** Score of one command for a normalized, non-empty query (0 = no match). */
export function scoreCommand(c: Command, q: string): number {
  const title = norm(c.title);
  const tw = words(title);
  if (title === q) return 1000;
  if (title.startsWith(q)) return 900;
  if (tw.some((w) => w.startsWith(q))) return 800;
  const qw = words(q);
  if (qw.length > 1 && qw.every((x) => tw.some((w) => w.startsWith(x)))) return 760;
  if (title.includes(q)) return 700;
  const kws = c.keywords.map(norm);
  if (kws.some((k) => k === q)) return 650;
  if (kws.some((k) => k.startsWith(q))) return 600;
  if (kws.some((k) => words(k).some((w) => w.startsWith(q)))) return 550;
  const path = norm(c.path.join(' '));
  if (words(path).some((w) => w.startsWith(q))) return 500;
  if (kws.some((k) => k.includes(q))) return 450;
  if (qw.length > 1) {
    const hay = new Set([...tw, ...words(path), ...kws.flatMap(words)]);
    if (qw.every((x) => [...hay].some((w) => w.startsWith(x)))) return 400;
  }
  if (q.length >= 2) {
    const f = fuzzy(q, title);
    if (f > 0.5) return 200 + Math.round(f * 100);
    const fk = Math.max(0, ...kws.map((k) => fuzzy(q, k)));
    if (fk > 0.6) return 100 + Math.round(fk * 50);
  }
  return 0;
}

const KIND_ORDER: Record<CommandKind, number> = { tool: 0, panel: 1, action: 2, control: 3 };

/** Ranked matches for `query`; an empty query lists tools and panels first. Ties keep registry order. */
export function searchCommands(cmds: Command[], query: string, limit = 12): Command[] {
  const q = norm(query);
  if (!q) {
    return cmds
      .map((c, i) => ({ c, i }))
      .sort((a, b) => KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.c);
  }
  return cmds
    .map((c, i) => ({ c, i, s: scoreCommand(c, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
