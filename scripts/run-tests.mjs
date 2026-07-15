import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = resolve(projectRoot, 'tests');
const outputRoot = await mkdtemp(join(tmpdir(), 'cat-plugins-tests-'));

try {
  const testFiles = (await collectTestFiles(testsRoot)).sort();
  if (testFiles.length === 0) {
    throw new Error('No test files were found.');
  }

  await build({
    entryPoints: testFiles,
    outdir: outputRoot,
    outbase: testsRoot,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning'
  });

  const compiledTests = testFiles.map((file) => {
    const relativePath = relative(testsRoot, file);
    return resolve(
      outputRoot,
      dirname(relativePath),
      `${basename(relativePath, extname(relativePath))}.cjs`
    );
  });
  const result = spawnSync(process.execPath, ['--test', ...compiledTests], {
    cwd: projectRoot,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }

  return files;
}
