# Contributing

Thanks for your interest! Data Viewer is a small, **read-only** table viewer powered by a single pandas engine.

## Requirements

You'll need Node.js and a Python environment with **pandas** and **NumPy** (NumPy backs the histograms and `*.npy`/`*.npz` loading) — plus, for the optional features, **matplotlib** (Colorize) and **pyarrow** (Parquet/Feather). The extension shells out to that interpreter; there is no pure-JS data path.

## Getting started

```bash
npm install
npm run build      # esbuild bundle (also copies the codicon font)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit (src/ only)
npm test           # unit tests (node:test via tsx, test/)
```

Press **F5** to launch an Extension Development Host, then open `sample-data/cities.csv` (no datetime and ordered categorical dtype inference), or run `sample-data/jup-vars.py` in a kernel and open its variables from the Jupyter **Variables** panel.

> [!NOTE]
> `npm test` transpiles with `tsx` (no type-checking) and `tsc` only covers `src/` — so rely on `npm test` for behavior and `npm run typecheck` for `src/` types.

## How it works

Every source — data files, Jupyter variables, debugger variables — funnels through one generated Python snippet (`buildDumpCode` in `src/pandasTable.ts`) that emits a single JSON payload. The extension host parses it, holds the full rows, and streams them to a virtualized webview in chunks. Sorting, filtering, colorizing, and the column statistics are all pandas and numpy operations inside that snippet, so every source behaves identically.

## Code layout

- `src/` — extension host: the pandas path (`pandasTable.ts`), the file editor and variable/debugger providers, the interpreter runner, and the (vscode-free) webview message loop
- `src/webview/` — the table UI; the pure, DOM-free helpers (`columns.ts`, `stats.ts`, `sorting.ts`, `colormaps.ts`, …) hold the testable logic, while `main.ts` is the DOM glue
- `test/` — unit tests for the pure modules and for the generated Python

## Submitting changes

- Keep changes scoped and incremental, with an imperative commit subject.
- Prefer doing data work in pandas (`buildDumpCode`) over reimplementing it in TypeScript, so files and variables stay identical.
- Add or adjust tests for any pure logic; verify a Python change against real pandas (see [AGENTS.md](AGENTS.md) for the bundle-and-run loop).
- Run `npm run typecheck` and `npm test` before opening a PR.

## Internals

The non-obvious design rationale, invariants, and gotchas live in **[AGENTS.md](AGENTS.md)** — worth reading before you touch the pandas path, the Colorize/statistics pipeline, or the host ↔ webview protocol.
