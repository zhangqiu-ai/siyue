import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Evaluate the actual palette without loading React Native or the preference store in Node.
const source = readFileSync(new URL('../src/ui/theme.ts', import.meta.url), 'utf8');
const paletteSource = source.slice(source.indexOf('const common ='), source.indexOf('export type Theme =')).replace('export const themes =', 'const themes =');
const themes = runInNewContext(`${stripTypeScriptTypes(paletteSource)}\nthemes`);
const luminance = (hex) => {
  const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const check = (colors, foreground, background, minimum) => {
  const ratio = contrast(colors[foreground], colors[background]);
  assert.ok(ratio >= minimum, `${foreground} on ${background}: ${ratio.toFixed(3)}:1 < ${minimum}:1`);
};
for (const [mode, { color }] of Object.entries(themes)) {
  test(`${mode}: body, secondary text and error messages stay readable on content surfaces`, () => {
    for (const background of ['background', 'surface', 'subtle']) {
      for (const foreground of ['ink', 'muted', 'error']) check(color, foreground, background, 4.5);
    }
  });
  test(`${mode}: focus cards and primary actions preserve text contrast when pressed`, () => {
    for (const background of ['focus', 'focusPressed']) {
      for (const foreground of ['onFocus', 'focusMuted']) check(color, foreground, background, 4.5);
    }
    for (const background of ['accent', 'accentPressed']) check(color, 'onAccent', background, 4.5);
  });
  test(`${mode}: input boundaries, selection, progress and completed checkboxes remain distinguishable`, () => {
    for (const background of ['background', 'surface', 'subtle']) check(color, 'controlBorder', background, 3);
    for (const background of ['focus', 'focusPressed', 'surface', 'subtle']) check(color, 'selectedBorder', background, 3);
    check(color, 'focusProgress', 'focusTrack', 3);
    check(color, 'progress', 'progressTrack', 3);
    check(color, 'onAccent', 'accent', 3);
    check(color, 'accent', 'surface', 3);
  });
  test(`${mode}: banners, warnings and the Apple button keep their paired text readable`, () => {
    check(color, 'warn', 'warnSurface', 4.5);
    check(color, 'ink', 'errorSurface', 4.5);
    check(color, 'ink', 'warnSurface', 4.5);
    check(color, 'error', 'errorSurface', 4.5);
    check(color, 'onApple', 'apple', 4.5);
  });
}
