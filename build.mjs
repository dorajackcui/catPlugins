import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const outdir = resolve('dist');
const watch = process.argv.includes('--watch');

const sharedConfig = {
  entryPoints: ['background.ts', 'content-script.ts', 'popup.ts'],
  bundle: true,
  format: 'iife',
  outdir,
  platform: 'browser',
  target: 'chrome114',
  sourcemap: true,
  legalComments: 'none'
};

async function copyStaticAssets() {
  await mkdir(outdir, { recursive: true });
  await cp('manifest.json', resolve(outdir, 'manifest.json'));
  await cp('popup.html', resolve(outdir, 'popup.html'));
  await cp('popup.css', resolve(outdir, 'popup.css'));
}

if (watch) {
  const ctx = await context(sharedConfig);
  await ctx.watch();
  await copyStaticAssets();
  console.log('Watching extension sources...');
} else {
  await rm(outdir, { recursive: true, force: true });
  await build(sharedConfig);
  await copyStaticAssets();
  console.log('Built extension into dist/');
}

