'use strict';

/* eslint-disable no-sync */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');

const projectRoot = path.join(__dirname, '..');

describe('#typescript', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-shots-ts-'));

    // Create node_modules with hot-shots pointing to project root
    const nmDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nmDir);
    fs.symlinkSync(projectRoot, path.join(nmDir, 'hot-shots'), 'junction');

    // Symlink @types/node so tsc can resolve built-in modules
    const typesDir = path.join(nmDir, '@types');
    const srcTypesDir = path.join(projectRoot, 'node_modules', '@types');
    if (fs.existsSync(srcTypesDir)) {
      fs.symlinkSync(srcTypesDir, typesDir, 'junction');
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run the TypeScript compiler against a temp directory.
   * @param {object} tsconfig
   * @param {string} code
   */
  function compileTs(tsconfig, code) {
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify(tsconfig, null, 2)
    );
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), code);

    const tscPath = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
      execFileSync(process.execPath, [tscPath, '--noEmit'], { cwd: tmpDir, encoding: 'utf8', stdio: 'pipe' });
    }
    catch (err) {
      const output = (err.stdout || '') + (err.stderr || '');
      assert.fail(`TypeScript compilation failed:\n${output}`);
    }
  }

  it('should compile named import with moduleResolution NodeNext (ESM)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }));
    compileTs(
      {
        compilerOptions: {
          target: 'esnext',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
        },
      },
      [
        'import { StatsD } from \'hot-shots\';',
        'const client = new StatsD({ mock: true });',
        'client.increment(\'test\');',
        'client.close();',
      ].join('\n')
    );
  });

  it('should compile default import with moduleResolution NodeNext (ESM)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }));
    compileTs(
      {
        compilerOptions: {
          target: 'esnext',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
        },
      },
      [
        'import HotShots from \'hot-shots\';',
        'const client = new HotShots({ mock: true });',
        'client.increment(\'test\');',
        'client.close();',
      ].join('\n')
    );
  });

  it('should compile both import styles with moduleResolution NodeNext (ESM)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }));
    compileTs(
      {
        compilerOptions: {
          target: 'esnext',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
        },
      },
      [
        'import HotShots, { StatsD } from \'hot-shots\';',
        'const client = new HotShots({ mock: true });',
        'const client2 = new StatsD({ mock: true });',
        'client.increment(\'test\');',
        'client2.increment(\'test\');',
        'client.close();',
        'client2.close();',
      ].join('\n')
    );
  });

  it('should compile with moduleResolution node (CJS)', () => {
    compileTs(
      {
        compilerOptions: {
          target: 'es2020',
          module: 'commonjs',
          moduleResolution: 'node',
          strict: true,
          esModuleInterop: true,
          noEmit: true,
        },
      },
      [
        'import HotShots from \'hot-shots\';',
        'import { StatsD } from \'hot-shots\';',
        'const client = new HotShots({ mock: true });',
        'const client2 = new StatsD({ mock: true });',
        'client.increment(\'test\');',
        'client2.increment(\'test\');',
        'client.close();',
        'client2.close();',
      ].join('\n')
    );
  });

  it('should compile with moduleResolution NodeNext (CJS)', () => {
    compileTs(
      {
        compilerOptions: {
          target: 'es2020',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
        },
      },
      [
        'import HotShots from \'hot-shots\';',
        'import { StatsD } from \'hot-shots\';',
        'const client = new HotShots({ mock: true });',
        'const client2 = new StatsD({ mock: true });',
        'client.increment(\'test\');',
        'client2.increment(\'test\');',
        'client.close();',
        'client2.close();',
      ].join('\n')
    );
  });

  it('should compile with strict tsconfig matching issue #316', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }));
    compileTs(
      {
        compilerOptions: {
          target: 'esnext',
          lib: ['DOM', 'ESNext'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          allowSyntheticDefaultImports: true,
          forceConsistentCasingInFileNames: true,
          noImplicitOverride: true,
          noImplicitReturns: true,
          noFallthroughCasesInSwitch: true,
          isolatedModules: true,
          noEmit: true,
        },
      },
      [
        'import HotShots, { StatsD } from \'hot-shots\';',
        'const client = new HotShots({ mock: true });',
        'const client2 = new StatsD({ mock: true });',
        'client.increment(\'test\');',
        'client2.increment(\'test\');',
        'client.close();',
        'client2.close();',
      ].join('\n')
    );
  });
});
