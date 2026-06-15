const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

// Copy the bundled codicon font + CSS into dist so the webview can load them
// (used for the dtype glyphs in column headers).
function copyCodicons() {
  const src = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
  const dest = 'dist/codicons';
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

async function main() {
  copyCodicons();
  const contexts = await Promise.all([
    esbuild.context({
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
    }),
    esbuild.context({
      ...common,
      entryPoints: ['src/webview/main.ts'],
      outfile: 'dist/webview/main.js',
      platform: 'browser',
      format: 'iife',
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
