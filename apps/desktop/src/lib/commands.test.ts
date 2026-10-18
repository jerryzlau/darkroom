import { describe, expect, it } from 'vitest';
import { buildCommands, scoreCommand, searchCommands, slug, type Command } from './commands';

const cmds = buildCommands();
const top = (q: string) => searchCommands(cmds, q)[0]?.id;
const ids = (q: string, n = 5) => searchCommands(cmds, q, n).map((c) => c.id);

describe('registry', () => {
  it('has unique ids and complete entries', () => {
    const seen = new Set<string>();
    for (const c of cmds) {
      expect(seen.has(c.id), c.id).toBe(false);
      seen.add(c.id);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.path.length).toBeGreaterThan(0);
      if (c.kind === 'action') expect(c.target, c.id).toBeUndefined();
      else expect(c.target?.section, c.id).toBeTruthy();
      if (c.kind === 'control') expect(c.target?.control, c.id).toBeTruthy();
    }
    expect(cmds.length).toBeGreaterThan(100);
  });

  it('targets a unique control within each section', () => {
    // several commands may point at the same group (e.g. mask kinds share the add-mask row),
    // but each (section, control) must be meant as one element: no titles collide within it
    const seen = new Map<string, string>();
    for (const c of cmds) {
      if (!c.target?.control) continue;
      const k = `${c.target.section}/${c.target.control}/${c.title}`;
      expect(seen.has(k), k).toBe(false);
      seen.set(k, c.id);
    }
  });

  it('covers tools, AI features and key actions', () => {
    for (const id of ['tool.crop', 'tool.spots', 'tool.masks', 'tool.select', 'tool.wb', 'ai.chat', 'ai.guided', 'ai.generate', 'action.export', 'action.importFolder', 'action.undo', 'action.resetAll', 'panel.detail', 'ctl.exposure'])
      expect(cmds.some((c) => c.id === id), id).toBe(true);
  });
});

describe('slug', () => {
  it('matches Slider label slugs', () => {
    expect(slug('Red / Cyan fringe')).toBe('red-cyan-fringe');
    expect(slug('Split 1')).toBe('split-1');
    expect(slug('Exposure')).toBe('exposure');
  });
});

describe('searchCommands', () => {
  it('finds tools by plain-language synonyms', () => {
    expect(top('pimple')).toBe('tool.spots');
    expect(top('blemish')).toBe('tool.spots');
    expect(top('acne')).toBe('tool.spots');
    expect(top('noise')).toBe('ctl.nr-luma');
    expect(top('denoise')).toBe('ctl.nr-luma');
    expect(top('bright')).toBe('ctl.exposure');
    expect(top('brightness')).toBe('ctl.exposure');
    expect(top('banana')).toBe('ai.generate');
    expect(top('remove object')).toBe('ai.generate');
    expect(top('sharpen')).toBe('ctl.sharpen');
    expect(top('straighten')).toBe('ctl.crop-angle');
    expect(ids('straighten', 3)).toContain('tool.crop');
    expect(top('acne')).toBe('tool.spots');
    expect(top('haze')).toBe('ctl.dehaze');
    expect(top('fog')).toBe('ctl.dehaze');
    expect(top('lasso')).toBe('tool.select');
    expect(top('eyedropper')).toBe('tool.wb');
    expect(top('warm')).toBe('ctl.temp');
    expect(top('magenta')).not.toBeUndefined();
    expect(ids('magenta')).toContain('ctl.tint');
    expect(top('dark corners')).toBe('ctl.lens-vignetting');
    expect(top('vignette')).toBe('ctl.vignette');
    expect(ids('vignette', 6)).toContain('ctl.lens-vignetting');
  });

  it('finds black & white treatment', () => {
    expect(top('black and white')).toBe('ctl.treatment');
    expect(top('monochrome')).toBe('ctl.treatment');
    expect(top('bw')).toBe('ctl.treatment');
  });

  it('ranks exact > prefix > word-start > substring > keyword > fuzzy', () => {
    const mk = (id: string, title: string, keywords: string[] = []): Command => ({ id, title, path: ['X'], kind: 'control', keywords });
    const list = [mk('fuzzy', 'Sxhxaxrxp'), mk('kw', 'Other', ['sharp']), mk('sub', 'Unsharp'), mk('word', 'Make Sharp'), mk('prefix', 'Sharpness'), mk('exact', 'Sharp')];
    expect(searchCommands(list, 'sharp').map((c) => c.id)).toEqual(['exact', 'prefix', 'word', 'sub', 'kw', 'fuzzy']);
    expect(scoreCommand(mk('none', 'Exposure'), 'shrp')).toBe(0);
    expect(searchCommands([mk('a', 'Spot Removal')], 'sptrm').map((c) => c.id)).toEqual(['a']);
  });

  it('title matches beat keyword matches', () => {
    expect(top('exposure')).toBe('ctl.exposure');
    expect(top('crop')).toBe('tool.crop');
    expect(top('mask')).toBe('tool.masks');
    expect(top('export')).toBe('action.export');
  });

  it('keeps registry order for ties (stable)', () => {
    const a = searchCommands(cmds, 'grain', 50).map((c) => c.id);
    const b = searchCommands(cmds, 'grain', 50).map((c) => c.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe('ctl.grain');
  });

  it('matches multi-word queries across title and path', () => {
    expect(top('orange sat')).toBe('ctl.hsl-sat-orange');
    expect(top('sky blue lum')).toBe('ctl.hsl-lum-blue');
  });

  it('is case and whitespace insensitive', () => {
    expect(top('  EXPOSURE ')).toBe('ctl.exposure');
  });

  it('lists tools and panels first for an empty query', () => {
    const r = searchCommands(cmds, '', 10);
    expect(r).toHaveLength(10);
    expect(r[0].kind).toBe('tool');
    expect(r.every((c) => c.kind === 'tool' || c.kind === 'panel')).toBe(true);
  });

  it('respects the limit and returns nothing for gibberish', () => {
    expect(searchCommands(cmds, 'a', 3)).toHaveLength(3);
    expect(searchCommands(cmds, 'qqzzxx')).toEqual([]);
  });
});
