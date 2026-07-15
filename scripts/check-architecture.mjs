import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryFiles = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    cwd: projectRoot,
    encoding: 'utf8'
  }
)
  .split('\0')
  .filter((file) => file && existsSync(resolve(projectRoot, file)));
const productionTypeScriptFiles = repositoryFiles.filter(
  (file) =>
    file.endsWith('.ts') &&
    !file.endsWith('.d.ts') &&
    !file.startsWith('tests/')
);
const violations = [];

checkRootLayout();
checkProductionImports();
checkDomainPurity();
checkCompositionAdapters();

if (violations.length > 0) {
  console.error('Architecture check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Architecture check passed (${productionTypeScriptFiles.length} production TypeScript modules).`
  );
}

function checkRootLayout() {
  const rootFiles = repositoryFiles.filter((file) => !file.includes('/'));
  const allowedRootTypeScript = new Set([
    'background.ts',
    'content-script.ts',
    'popup.ts'
  ]);

  for (const file of rootFiles) {
    if (file.endsWith('.d.ts')) {
      violations.push(
        `${file}: ambient declarations belong in types/, not at repository root.`
      );
    } else if (file.endsWith('.ts') && !allowedRootTypeScript.has(file)) {
      violations.push(
        `${file}: root TypeScript must be an entry point; move implementation code into a responsibility folder.`
      );
    }

    if (file.endsWith('.mjs')) {
      violations.push(
        `${file}: repository tooling belongs in scripts/, not at repository root.`
      );
    }

    if (file.endsWith('.html') || file.endsWith('.css')) {
      violations.push(
        `${file}: static source assets belong beside their feature module, not at repository root.`
      );
    }
  }
}

function checkProductionImports() {
  for (const file of productionTypeScriptFiles) {
    const source = readFileSync(resolve(projectRoot, file), 'utf8');
    const imports = collectRelativeImports(file, source);

    for (const importedFile of imports) {
      if (importedFile === 'shared/types.ts') {
        violations.push(
          `${file}: production code must import a focused shared contract instead of shared/types.ts.`
        );
      }

      if (file.startsWith('shared/') && !importedFile.startsWith('shared/')) {
        violations.push(
          `${file}: shared modules must remain layer-neutral; found import ${importedFile}.`
        );
      }

      if (file.startsWith('domain/') && importedFile.startsWith('platforms/')) {
        violations.push(
          `${file}: domain rules must not depend on a platform implementation (${importedFile}).`
        );
      }

      if (
        file.startsWith('content/') &&
        /^platforms\/[^/]+\//.test(importedFile)
      ) {
        violations.push(
          `${file}: content flow must use a platform-level port instead of a platform implementation (${importedFile}).`
        );
      }

      const sourcePlatform = /^platforms\/([^/]+)\//.exec(file)?.[1];
      const targetPlatform = /^platforms\/([^/]+)\//.exec(importedFile)?.[1];
      if (
        sourcePlatform &&
        targetPlatform &&
        sourcePlatform !== targetPlatform
      ) {
        violations.push(
          `${file}: platform modules must not import another platform (${importedFile}).`
        );
      }
    }

    if (
      file === 'popup/view.ts' &&
      imports.includes('popup/controller.ts')
    ) {
      violations.push(
        `${file}: the view must depend on popup/contracts.ts, not the workflow controller.`
      );
    }
  }
}

function checkDomainPurity() {
  for (const file of productionTypeScriptFiles.filter((candidate) =>
    candidate.startsWith('domain/')
  )) {
    const source = readFileSync(resolve(projectRoot, file), 'utf8');
    if (/\b(?:chrome|document|window)\s*\./.test(source)) {
      violations.push(
        `${file}: domain rules must not access Chrome or browser DOM globals.`
      );
    }
  }
}

function checkCompositionAdapters() {
  for (const file of [
    'platforms/gientrans/adapter.ts',
    'platforms/phrase/adapter.ts'
  ]) {
    const source = readFileSync(resolve(projectRoot, file), 'utf8');
    if (/\bquerySelector(?:All)?\s*[<(]/.test(source)) {
      violations.push(
        `${file}: DOM discovery belongs in the platform row reader.`
      );
    }
  }
}

function collectRelativeImports(file, source) {
  const imports = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) {
      continue;
    }

    const importedFile = posix.normalize(
      posix.join(posix.dirname(file), specifier)
    );
    imports.push(
      posix.extname(importedFile) ? importedFile : `${importedFile}.ts`
    );
  }

  return imports;
}
