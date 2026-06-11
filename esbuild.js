const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

async function main() {
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
