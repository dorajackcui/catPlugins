import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(projectRoot, 'dist');
const watch = process.argv.includes('--watch');

const sharedConfig = {
  entryPoints: [
    resolve(projectRoot, 'background.ts'),
    resolve(projectRoot, 'content-script.ts'),
    resolve(projectRoot, 'popup.ts')
  ],
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
  await cp(
    resolve(projectRoot, 'manifest.json'),
    resolve(outdir, 'manifest.json')
  );
  await cp(
    resolve(projectRoot, 'popup/index.html'),
    resolve(outdir, 'popup.html')
  );
  await cp(
    resolve(projectRoot, 'popup/styles.css'),
    resolve(outdir, 'popup.css')
  );
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

