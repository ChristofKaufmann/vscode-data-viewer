/**
 * The single pandas-backed data path: Python code that serializes any
 * DataFrame-like object as one JSON payload on stdout, plus the TypeScript
 * side that turns the payload into table columns/rows. Used both by the
 * Jupyter kernel path (variables) and the subprocess path (CSV files).
 */
import { ColumnStat, ColumnType, SortKey } from './shared/protocol';

export const MAX_ROWS = 100_000;

/** Number of equal-width bins in the per-column numeric histogram. */
export const HIST_BINS = 16;

/** Colormap applied to numeric values for Colorize (any matplotlib name). */
export const DEFAULT_COLORMAP = 'viridis';

export interface DumpPayload {
  total: number;
  /** The DataFrame index name, or "" when the index is unnamed. */
  indexName: string;
  table: { columns: string[]; index: unknown[]; data: unknown[][] };
  /**
   * Per-cell background colors for Colorize, aligned to `table.data`
   * (rows × data columns): a "#rrggbb" string for colored cells, null for
   * uncolored cells (non-numeric/non-datetime, NaN/NaT, or a disabled type).
   * null overall when nothing is colored (no colorable columns, all types
   * disabled, or matplotlib unavailable in the environment).
   */
  colors: (string | null)[][] | null;
  /**
   * Per-column dtype info aligned to the final columns (index first, then data
   * columns), or null if it couldn't be computed.
   */
  columnTypes: ColumnType[] | null;
  /**
   * Per-column summary stats aligned to the final columns (index first), or
   * null if they couldn't be computed. Counted over the full (filtered) frame,
   * not the truncated `head`, so the counts are exact.
   */
  stats: ColumnStat[] | null;
  /**
   * An example `DataFrame.query` expression for the filter input placeholder,
   * built from the real dtypes (so a MultiIndex references a level by name).
   * null when there are no data columns. The webview wraps it as the hint text.
   */
  filterHint: string | null;
  /** pandas error message from a failed filter query, or null. */
  filterError: string | null;
}

export interface DumpOptions {
  /** matplotlib colormap name. */
  colormap?: string;
  /** Symmetric range around 0 (vmax = max(|vmin|, |vmax|), vmin = -vmax). */
  center?: boolean;
  /** Range computed per column instead of once per type group. */
  columnwise?: boolean;
  /** Color numeric columns (default true). */
  colorizeNumeric?: boolean;
  /** Color datetime/timedelta columns by their timestamp (default true). */
  colorizeDatetime?: boolean;
  /** Color ordered categorical columns by their rank (default true). */
  colorizeCategorical?: boolean;
  /** Color unordered/text/bool cells by value, matching the stacked bar (default false). */
  colorizeText?: boolean;
  /** Multi-column sort keys (primary first); columns are data-column positions, -1 = index. */
  sort?: SortKey[];
  /** A pandas `DataFrame.query` expression; empty = no filter. */
  filter?: string;
}

/**
 * Builds Python code that evaluates `objExpr`, normalizes it to a DataFrame
 * and prints the payload. Everything lives inside one temporary function so a
 * kernel's user namespace only ever sees (and loses) one name.
 *
 * Cell colors are computed per type group: numeric columns share one
 * vmin/vmax, datetime/timedelta columns share a separate one (so timestamps
 * never distort the numeric range). `columnwise` instead ranges each column on
 * its own; `center` makes a range symmetric around 0.
 */
export function buildDumpCode(objExpr: string, options: DumpOptions = {}): string {
  const cmap = options.colormap ?? DEFAULT_COLORMAP;
  const center = options.center ?? false;
  const columnwise = options.columnwise ?? false;
  const colorizeNumeric = options.colorizeNumeric ?? true;
  const colorizeDatetime = options.colorizeDatetime ?? true;
  const colorizeCategorical = options.colorizeCategorical ?? true;
  const colorizeText = options.colorizeText ?? false;
  // Sort keys become a Python list of (position, descending) tuples (-1 = the
  // index). Filter to safe integers so the literal can't be anything but
  // numbers/bools.
  const sortKeys = (options.sort ?? []).filter((k) => Number.isInteger(k.column) && k.column >= -1);
  const sortLiteral =
    '[' + sortKeys.map((k) => `(${k.column}, ${k.descending ? 'True' : 'False'})`).join(', ') + ']';
  // A JSON string literal is a valid Python string literal (handles escaping).
  const filterLiteral = JSON.stringify(options.filter ?? '');
  return [
    'def _VSCODE_dataviewer_dump():',
    '    import csv',
    '    import json',
    '    import pandas as pd',
    '    def _read_csv(path):',
    // Sniff the delimiter on a *decompressed* sample (get_handle infers
    // compression), constrained to common delimiters. Fall back to pandas\'
    // own sniffer (sep=None) if anything goes wrong — it also decompresses.
    // read_csv then infers compression from the extension by default.
    '        _sep = None',
    '        try:',
    '            from pandas.io.common import get_handle',
    '            with get_handle(path, "r", compression="infer", errors="replace") as _h:',
    '                _sample = _h.handle.read(65536)',
    '            _sep = csv.Sniffer().sniff(_sample, delimiters=",;\\t|").delimiter',
    '        except Exception:',
    '            _sep = None',
    '        if _sep is None:',
    '            return pd.read_csv(path, sep=None, engine="python")',
    '        return pd.read_csv(path, sep=_sep)',
    `    obj = ${objExpr}`,
    '    if isinstance(obj, pd.Series):',
    '        obj = obj.to_frame()',
    '    elif not isinstance(obj, pd.DataFrame):',
    '        obj = pd.DataFrame(obj)',
    // Filter via DataFrame.query (bare column names, &/|, .isna(), `index`, …).
    // engine="python" so string/datetime/categorical comparisons work. On a bad
    // expression we report the error and leave the data unfiltered.
    `    _filter = ${filterLiteral}`,
    '    _filter_error = None',
    '    if _filter:',
    '        try:',
    '            obj = obj.query(_filter, engine="python")',
    '        except Exception as _e:',
    '            _filter_error = str(_e)',
    // Stable multi-key sort. Each key is a data-column position, or -1 for the
    // index. reset_index materializes the index level(s) as leading columns so
    // index and columns sort uniformly; we then reorder the original frame by
    // the resulting row positions (preserving its index, names and dtypes).
    // Left unsorted if the keys don't apply (e.g. uncomparable mixed-type column).
    `    _sort = ${sortLiteral}`,
    '    if _sort:',
    '        try:',
    '            _nlev = obj.index.nlevels',
    '            _si = obj.reset_index(drop=False, allow_duplicates=True)',
    '            _si.columns = range(_si.shape[1])',
    '            _by = []',
    '            _asc = []',
    '            for _c, _d in _sort:',
    '                if _c < 0:',
    '                    _by.extend(range(_nlev))',
    '                    _asc.extend([not _d] * _nlev)',
    '                else:',
    '                    _by.append(_c + _nlev)',
    '                    _asc.append(not _d)',
    '            _si = _si.sort_values(by=_by, ascending=_asc, kind="stable", na_position="last")',
    '            obj = obj.iloc[_si.index.to_numpy()]',
    '        except Exception:',
    '            pass',
    '    total = len(obj)',
    // Per-column "nominal" info for unordered/text/bool columns: the stacked-bar
    // segments AND a value->color map for cell coloring, so the bar and the cells
    // use the *same* qualitative palette. Built once over the full filtered frame
    // and reused by both the stats and the colors blocks. value_counts is walked a
    // count-level at a time against a 9-color budget (tab10 minus the gray C7);
    // the overflow level + rarer values collapse into a gray "(other)".
    '    _nominfo = None',
    '    try:',
    '        def _nominal_info(_c):',
    '            if pd.api.types.is_datetime64_any_dtype(_c) or pd.api.types.is_timedelta64_dtype(_c):',
    '                return None',
    '            if pd.api.types.is_numeric_dtype(_c) and not pd.api.types.is_bool_dtype(_c):',
    '                return None',
    '            if isinstance(_c.dtype, pd.CategoricalDtype) and _c.dtype.ordered:',
    '                return None',
    '            _vc = _c.value_counts(dropna=True)',
    '            if _vc.size == 0:',
    '                return None',
    '            _cv = _vc.values',
    '            _n = int(_cv.shape[0])',
    '            _budget = 9',
    '            _i = 0',
    '            while _i < _n:',
    '                _lvl = _cv[_i]',
    '                if _i + _budget < _n and _cv[_i + _budget] == _lvl:',
    '                    break',
    '                _j = _i',
    '                while _j < _n and _cv[_j] == _lvl:',
    '                    _j += 1',
    '                _budget -= _j - _i',
    '                _i = _j',
    '            _keep = _i',
    '            _labels = [str(_k) for _k in _vc.index[:_keep]]',
    '            _counts = [int(_x) for _x in _cv[:_keep]]',
    '            _other = int(_cv[_keep:].sum())',
    '            _colors = None',
    '            _vmap = {}',
    '            try:',
    '                import matplotlib as _mpl',
    '                _qual = _mpl.colormaps["tab10"]',
    '                _palidx = [0, 1, 2, 3, 4, 5, 6, 8, 9]',
    '                _hex = ["#%02x%02x%02x" % tuple(int(round(_x * 255)) for _x in _qual(_palidx[_k])[:3]) for _k in range(_keep)]',
    '                _vmap = {str(_vc.index[_k]): _hex[_k] for _k in range(_keep)}',
    '                _colors = _hex + (["#888888"] if _other > 0 else [])',
    '            except Exception:',
    '                _colors = None',
    '                _vmap = {}',
    '            _bl = _labels + (["(other)"] if _other > 0 else [])',
    '            _bc = _counts + ([_other] if _other > 0 else [])',
    '            _seg = {"labels": _bl, "counts": _bc, "colors": _colors, "unique": int(_vc.size), "allUnique": bool(_cv[0] == 1)}',
    '            return {"segments": _seg, "vmap": _vmap}',
    '        _nominfo = []',
    '        for _i in range(obj.shape[1]):',
    '            try:',
    '                _nominfo.append(_nominal_info(obj.iloc[:, _i]))',
    '            except Exception:',
    '                _nominfo.append(None)',
    '    except Exception:',
    '        _nominfo = None',
    // Per-column summary stats over the *full* filtered frame (not the truncated
    // head, so counts are exact). Aligned index-first like column_types. The
    // missing (NaN/NaT/None) count is meaningful for every dtype; numeric data
    // columns also get an equal-width histogram (np.histogram returns counts +
    // edges in one call) over their non-null values.
    '    stats = None',
    '    try:',
    '        import numpy as _np',
    `        _HB = ${HIST_BINS}`,
    `        _center = ${center ? 'True' : 'False'}`,
    `        _columnwise = ${columnwise ? 'True' : 'False'}`,
    `        _do_num = ${colorizeNumeric ? 'True' : 'False'}`,
    `        _do_dt = ${colorizeDatetime ? 'True' : 'False'}`,
    `        _do_cat = ${colorizeCategorical ? 'True' : 'False'}`,
    '        def _missing(_x):',
    '            try:',
    '                return int(pd.isna(_x).sum())',
    '            except Exception:',
    '                return 0',
    // "Nice" bin edges (Heckbert): pick a step of the form {1,2,5}×10^k near
    // range/HIST_BINS, then snap the low/high edges down/up to multiples of it,
    // so every edge is a readable round number on a shared grid. Edges are
    // rounded to the step's precision to shed floating-point noise, then shipped
    // verbatim (the webview shows them as-is).
    '        def _nice(_x, _round):',
    '            _e = _np.floor(_np.log10(_x))',
    '            _f = _x / 10.0 ** _e',
    '            if _round:',
    '                _nf = 1 if _f < 1.5 else 2 if _f < 3 else 5 if _f < 7 else 10',
    '            else:',
    '                _nf = 1 if _f <= 1 else 2 if _f <= 2 else 5 if _f <= 5 else 10',
    '            return _nf * 10.0 ** _e',
    // Round to 3 significant figures for the min/median/max labels (the actual
    // data values, which don\'t sit on the bin grid).
    '        def _sig(_x):',
    '            if not _np.isfinite(_x) or _x == 0:',
    '                return 0.0',
    '            return round(float(_x), 2 - int(_np.floor(_np.log10(abs(_x)))))',
    // Calendar-aware datetime bin edges: pick the finest unit/step giving <= _HB
    // bins, snap the start to that unit (year/month via replace, finer via floor),
    // and build the edges with pd.date_range so they sit on real boundaries.
    '        def _date_edges(_lo, _hi):',
    '            _span = (_hi - _lo).total_seconds()',
    '            _cands = [("s", 1), ("5s", 5), ("15s", 15), ("30s", 30), ("min", 60), ("5min", 300), ("15min", 900), ("30min", 1800), ("h", 3600), ("2h", 7200), ("6h", 21600), ("12h", 43200), ("D", 86400), ("2D", 172800), ("7D", 604800), ("MS", 2629800), ("3MS", 7889400), ("6MS", 15778800), ("YS", 31557600), ("2YS", 63115200), ("5YS", 157788000), ("10YS", 315576000), ("20YS", 631152000), ("50YS", 1577880000), ("100YS", 3155760000)]',
    '            _freq = _cands[-1][0]',
    '            for _f, _a in _cands:',
    '                if _span / _a <= _HB:',
    '                    _freq = _f; break',
    '            if "Y" in _freq:',
    '                _start = _lo.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0, nanosecond=0)',
    '            elif "M" in _freq:',
    '                _start = _lo.replace(day=1, hour=0, minute=0, second=0, microsecond=0, nanosecond=0)',
    '            else:',
    '                try:',
    '                    _start = _lo.floor(_freq)',
    '                except Exception:',
    '                    _start = _lo.floor("D")',
    '            _e = pd.date_range(start=_start, end=_hi, freq=_freq)',
    '            if len(_e) < 1 or _e[-1] <= _hi:',
    '                _e = pd.date_range(start=_start, periods=len(_e) + 1, freq=_freq)',
    '            return _e',
    // Nice timedelta step (seconds): the smallest readable duration giving <= _HB bins.
    '        def _td_step(_span):',
    '            for _s in [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000, 5184000, 7776000, 15552000, 31536000]:',
    '                if _span / _s <= _HB:',
    '                    return _s',
    '            return 31536000',
    // Per-bin histogram colors: tint each bar by its bin center mapped through the
    // colormap over [_lo, _hi]. The range is the *same* one the cell coloring uses
    // (group-shared or columnwise, optionally centered at 0), computed in a post-
    // pass below — so the bars read as a gradient and match the colored cells.
    // Edges and _lo/_hi share one unit (data value, or seconds for datetime/td).
    '        def _bin_colors(_edges, _lo, _hi):',
    '            try:',
    '                import matplotlib as _mpl',
    `                _cm = _mpl.colormaps[${JSON.stringify(cmap)}]`,
    '                _rng = _hi - _lo',
    '                _out = []',
    '                for _j in range(len(_edges) - 1):',
    '                    _ctr = (float(_edges[_j]) + float(_edges[_j + 1])) / 2',
    '                    _t = (_ctr - _lo) / _rng if _rng > 0 else 0.0',
    '                    _t = 0.0 if _t < 0 else 1.0 if _t > 1 else _t',
    '                    _rgb = [int(round(_x * 255)) for _x in _cm(_t)[:3]]',
    '                    _out.append("#%02x%02x%02x" % (_rgb[0], _rgb[1], _rgb[2]))',
    '                return _out',
    '            except Exception:',
    '                return None',
    '        def _hist(_c):',
    '            try:',
    '                _is_num = pd.api.types.is_numeric_dtype(_c) and not pd.api.types.is_bool_dtype(_c)',
    '                _is_dt = pd.api.types.is_datetime64_any_dtype(_c)',
    '                _is_td = pd.api.types.is_timedelta64_dtype(_c)',
    '                if not (_is_num or _is_dt or _is_td):',
    '                    return None',
    '                if _is_num:',
    '                    _v = _c.to_numpy(dtype="float64")',
    '                    _v = _v[_np.isfinite(_v)]',
    '                    if not _v.size:',
    '                        return None',
    '                    _lo, _hi = float(_v.min()), float(_v.max())',
    '                    _md = float(_np.median(_v))',
    '                    if _hi <= _lo:',
    '                        return {"counts": [int(_v.size)], "edges": [_lo, _hi], "min": _sig(_lo), "median": _sig(_lo), "max": _sig(_lo)}',
    '                    _step = _nice((_hi - _lo) / _HB, True)',
    '                    _nmin = _np.floor(_lo / _step) * _step',
    '                    _nmax = _np.ceil(_hi / _step) * _step',
    '                    _edges = _np.arange(_nmin, _nmax + 0.5 * _step, _step)',
    '                    _counts, _edges = _np.histogram(_v, bins=_edges)',
    '                    _dec = int(max(0, -_np.floor(_np.log10(_step) + 1e-9)))',
    '                    return {"counts": [int(_n) for _n in _counts], "edges": [round(float(_e), _dec) for _e in _edges], "min": _sig(_lo), "median": _sig(_md), "max": _sig(_hi)}',
    '                _vv = _c.dropna()',
    '                if not len(_vv):',
    '                    return None',
    '                _lov, _hiv, _mdv = _vv.min(), _vv.max(), _vv.median()',
    // Normalize to nanoseconds explicitly — datetime64 may be [s]/[ms]/[us], so a
    // bare .astype("int64") is not necessarily ns, while the date_range edges are.
    '                if _is_dt:',
    '                    _pos = _vv.astype("datetime64[ns]").astype("int64").to_numpy() / 1e9',
    '                    _ls, _ms, _hs = _lov.value / 1e9, _mdv.value / 1e9, _hiv.value / 1e9',
    '                    if _hiv <= _lov:',
    '                        return {"counts": [int(len(_vv))], "edges": [_ls, _ls], "min": _ls, "median": _ls, "max": _ls, "labels": {"edges": [str(_lov), str(_lov)], "min": str(_lov), "median": str(_lov), "max": str(_lov)}}',
    '                    _ets = _date_edges(_lov, _hiv)',
    '                    _ep = _ets.astype("datetime64[ns]").astype("int64").to_numpy() / 1e9',
    '                    _elabels = [str(_t) for _t in _ets]',
    '                else:',
    '                    _pos = _vv.astype("timedelta64[ns]").astype("int64").to_numpy() / 1e9',
    '                    _ls, _ms, _hs = _lov.total_seconds(), _mdv.total_seconds(), _hiv.total_seconds()',
    '                    if _hs <= _ls:',
    '                        return {"counts": [int(len(_vv))], "edges": [_ls, _ls], "min": _ls, "median": _ls, "max": _ls, "labels": {"edges": [str(_lov), str(_lov)], "min": str(_lov), "median": str(_lov), "max": str(_lov)}}',
    '                    _step = _td_step(_hs - _ls)',
    '                    _ep = _np.arange(_np.floor(_ls / _step) * _step, _np.ceil(_hs / _step) * _step + 0.5 * _step, _step)',
    '                    _elabels = [str(pd.Timedelta(seconds=float(_e))) for _e in _ep]',
    '                _counts, _ep = _np.histogram(_pos, bins=_ep)',
    '                return {"counts": [int(_n) for _n in _counts], "edges": [float(_e) for _e in _ep], "min": _ls, "median": _ms, "max": _hs, "labels": {"edges": _elabels, "min": str(_lov), "median": str(_mdv), "max": str(_hiv)}}',
    '            except Exception:',
    '                return None',
    // Ordered-categorical columns get a bar per category in *category order*
    // (so the rank-based colors read as a gradient), with each bar tinted by the
    // colormap at its rank — the bars map 1:1 to the categories.
    '        def _bars(_c):',
    '            try:',
    '                if not isinstance(_c.dtype, pd.CategoricalDtype) or not _c.dtype.ordered:',
    '                    return None',
    '                _cats = list(_c.dtype.categories)',
    '                _vc = _c.value_counts()',
    '                _counts = [int(_vc.get(_k, 0)) for _k in _cats]',
    '                _labels = [str(_k) for _k in _cats]',
    '                _colors = None',
    // Tint the bars only when the categorical Colorize toggle is on, so turning
    // Colorize off leaves them in the default single fill (like the cells and the
    // numeric/datetime histograms).
    '                if _do_cat:',
    '                  try:',
    '                    import matplotlib as _mpl',
    `                    _cm = _mpl.colormaps[${JSON.stringify(cmap)}]`,
    '                    _k = len(_cats)',
    '                    _colors = []',
    '                    for _j in range(_k):',
    '                        _t = _j / (_k - 1) if _k > 1 else 0.0',
    '                        _rgb = [int(round(_x * 255)) for _x in _cm(_t)[:3]]',
    '                        _colors.append("#%02x%02x%02x" % (_rgb[0], _rgb[1], _rgb[2]))',
    '                  except Exception:',
    '                    _colors = None',
    '                return {"labels": _labels, "counts": _counts, "colors": _colors}',
    '            except Exception:',
    '                return None',
    '        stats = [{"missing": _missing(obj.index)}]',
    // Collect each histogram with its range group ("num"/"datetime"/"timedelta")
    // so a second pass can color the bars with the same range the cells use.
    '        _hgroup = []',
    '        for _i in range(obj.shape[1]):',
    '            _col = obj.iloc[:, _i]',
    '            _entry = {"missing": _missing(_col)}',
    '            _h = _hist(_col)',
    '            if _h is not None:',
    '                _entry["histogram"] = _h',
    '                if pd.api.types.is_datetime64_any_dtype(_col):',
    '                    _hgroup.append((_h, "datetime"))',
    '                elif pd.api.types.is_timedelta64_dtype(_col):',
    '                    _hgroup.append((_h, "timedelta"))',
    '                else:',
    '                    _hgroup.append((_h, "num"))',
    '            else:',
    '                _b = _bars(_col)',
    '                if _b is not None:',
    '                    _entry["bars"] = _b',
    '                elif _nominfo and _nominfo[_i] is not None:',
    '                    _entry["segments"] = _nominfo[_i]["segments"]',
    '            stats.append(_entry)',
    // Color the histogram bars. Range mirrors the cell coloring: per-column when
    // columnwise, else shared across the group (min of mins / max of maxes, using
    // each histogram\'s own min/max in its native unit); centered at 0 for numeric
    // and timedelta (not datetime, whose origin is arbitrary). Each bar\'s center
    // is then mapped through the colormap over that range.
    '        _hranges = {}',
    '        for _h, _g in _hgroup:',
    '            _lo, _hi = _h["min"], _h["max"]',
    '            if _g in _hranges:',
    '                _hranges[_g] = (min(_hranges[_g][0], _lo), max(_hranges[_g][1], _hi))',
    '            else:',
    '                _hranges[_g] = (_lo, _hi)',
    '        for _h, _g in _hgroup:',
    // Color a histogram only when its type\'s Colorize toggle is on (numeric ->
    // _do_num, datetime/timedelta -> _do_dt), so turning Colorize off leaves the
    // bars in the default single fill, like the cells.
    '            if (_g == "num" and not _do_num) or (_g in ("datetime", "timedelta") and not _do_dt):',
    '                _h["colors"] = None',
    '                continue',
    '            if _columnwise:',
    '                _lo, _hi = _h["min"], _h["max"]',
    '            else:',
    '                _lo, _hi = _hranges[_g]',
    '            if _center and _g != "datetime":',
    '                _hi = max(abs(_lo), abs(_hi)); _lo = -_hi',
    '            _h["colors"] = _bin_colors(_h["edges"], _lo, _hi)',
    '    except Exception:',
    '        stats = None',
    // An example `DataFrame.query` expression for the filter input placeholder,
    // built here (not in JS) so it can use the real dtypes and a level name for a
    // MultiIndex. Shape: `<index clause> | (<other>.notna() & <value clause>)`.
    // - value clause picks a column by dtype: numeric `> 0`, else datetime
    //   `> '1986-06-30'`, else timedelta `< '...'`, else the last column
    //   `!= <its first value>`.
    // - index clause: `index` for a single index; for a MultiIndex the level's
    //   name (`ilevel_N` only works for *unnamed* levels), backticked when not a
    //   clean identifier; `!=` is dtype-safe (text/categorical reject `<`/`>`).
    // Values are repr() literals (numpy scalars unwrapped via .item()), or a
    // quoted str() for datetime/timedelta (their repr is a Timestamp(...) call).
    '    filter_hint = None',
    '    try:',
    '        import keyword as _kw',
    '        def _lit(_v):',
    '            try:',
    '                _v = _v.item()',
    '            except Exception:',
    '                pass',
    '            return repr(_v)',
    '        def _qcol(_name):',
    '            _s = str(_name)',
    '            return _s if _s.isidentifier() and not _kw.iskeyword(_s) else "`" + _s + "`"',
    '        def _is_time(_x):',
    '            return pd.api.types.is_datetime64_any_dtype(_x) or pd.api.types.is_timedelta64_dtype(_x)',
    '        def _rhs(_v, _t):',
    '            return repr(str(_v)) if _t else _lit(_v)',
    '        _cols = list(obj.columns)',
    '        if _cols:',
    '            _dt = obj.dtypes',
    '            _vi = None',
    '            for _i in range(len(_cols)):',
    '                if pd.api.types.is_numeric_dtype(_dt.iloc[_i]) and not pd.api.types.is_bool_dtype(_dt.iloc[_i]):',
    '                    _vi, _vc = _i, "%s > 0" % _qcol(_cols[_i]); break',
    '            if _vi is None:',
    '                for _i in range(len(_cols)):',
    '                    if pd.api.types.is_datetime64_any_dtype(_dt.iloc[_i]):',
    '                        _vi, _vc = _i, "%s > \'1986-06-30\'" % _qcol(_cols[_i]); break',
    '            if _vi is None:',
    '                for _i in range(len(_cols)):',
    '                    if pd.api.types.is_timedelta64_dtype(_dt.iloc[_i]):',
    '                        _vi, _vc = _i, "%s < \'1 days 01:23:45\'" % _qcol(_cols[_i]); break',
    '            if _vi is None:',
    '                _vi = len(_cols) - 1',
    '                _fv = obj.iloc[0, _vi] if len(obj) else ""',
    '                _vc = "%s != %s" % (_qcol(_cols[_vi]), _lit(_fv))',
    '            _ni = next((_i for _i in range(len(_cols)) if _i != _vi), None)',
    // Order the .notna() and value clauses by column position so the hint lists
    // columns in their actual order, not value-column-last.
    '            if _ni is None:',
    '                _inner = _vc',
    '            elif _vi < _ni:',
    '                _inner = "(%s & %s.notna())" % (_vc, _qcol(_cols[_ni]))',
    '            else:',
    '                _inner = "(%s.notna() & %s)" % (_qcol(_cols[_ni]), _vc)',
    '            _ii = obj.index',
    '            _pos = 1 if len(_ii) > 1 else (0 if len(_ii) else None)',
    '            _idx = None',
    '            if _pos is not None:',
    '                if isinstance(_ii, pd.MultiIndex):',
    '                    _name0 = _ii.names[0]',
    '                    _lhs = _qcol(_name0) if _name0 is not None else "ilevel_0"',
    '                    _lv = _ii.get_level_values(0)',
    '                    _idx = "%s != %s" % (_lhs, _rhs(_lv[_pos], _is_time(_lv)))',
    '                else:',
    '                    _idx = "index != %s" % _rhs(_ii[_pos], _is_time(_ii))',
    '            filter_hint = " | ".join([_idx, _inner]) if _idx else _inner',
    '    except Exception:',
    '        filter_hint = None',
    `    head = obj.head(${MAX_ROWS}).copy()`,
    // index.names works for both a regular Index (one element) and a
    // MultiIndex (whose .name is always None); join the level names so a
    // MultiIndex still gets a header. Blank when no level is named.
    '    index_names = [str(n) if n is not None else "" for n in head.index.names]',
    '    index_name = ", ".join(index_names) if any(index_names) else ""',
    // Render datetimes/timedeltas like str()/print ("2022-05-15 08:30:00")
    // instead of the ISO format to_json emits; NaT stays null (blank cell).
    '    def _vscode_fmt(col):',
    '        if pd.api.types.is_datetime64_any_dtype(col) or pd.api.types.is_timedelta64_dtype(col):',
    '            return col.map(lambda x: None if pd.isna(x) else str(x))',
    '        return col',
    // Keep the original-dtype frame for color computation; `head` becomes the
    // stringified display version.
    '    _raw = head',
    '    head = head.apply(_vscode_fmt)',
    '    head.columns = [str(c) for c in head.columns]',
    '    if isinstance(head.index, pd.MultiIndex):',
    '        head.index = [str(i) for i in head.index]',
    '    elif pd.api.types.is_datetime64_any_dtype(head.index) or pd.api.types.is_timedelta64_dtype(head.index):',
    '        head.index = [None if pd.isna(i) else str(i) for i in head.index]',
    '    table = head.to_json(orient="split", date_format="iso", default_handler=str)',
    // Cell colors, computed from the original-dtype frame. Numeric, datetime
    // and timedelta columns form three separate range groups (each in its own
    // unit, so they never distort each other); within a group the range is
    // shared, or per-column when columnwise. Ordered categoricals are colored by
    // rank over their full 0..n-1 code range (always per-column). `center` makes
    // a range symmetric but is skipped for datetimes (arbitrary epoch origin) and
    // categoricals (0 is just the first category). Wrapped in try/except so a
    // kernel without matplotlib still views fine.
    '    colors = None',
    '    try:',
    '        import numpy as _np',
    '        import matplotlib as _mpl',
    `        _cmap = _mpl.colormaps[${JSON.stringify(cmap)}]`,
    `        _center = ${center ? 'True' : 'False'}`,
    `        _columnwise = ${columnwise ? 'True' : 'False'}`,
    `        _do_num = ${colorizeNumeric ? 'True' : 'False'}`,
    `        _do_dt = ${colorizeDatetime ? 'True' : 'False'}`,
    `        _do_cat = ${colorizeCategorical ? 'True' : 'False'}`,
    `        _do_text = ${colorizeText ? 'True' : 'False'}`,
    '        _ncols, _nrows = _raw.shape[1], _raw.shape[0]',
    '        _vals = [None] * _ncols',
    '        _grp = [None] * _ncols',
    '        _fixed = [None] * _ncols',
    '        for _i in range(_ncols):',
    '            _c = _raw.iloc[:, _i]',
    '            if _do_num and pd.api.types.is_numeric_dtype(_c) and not pd.api.types.is_bool_dtype(_c):',
    '                _vals[_i] = _c.to_numpy(dtype="float64")',
    '                _grp[_i] = "num"',
    '            elif _do_dt and (pd.api.types.is_datetime64_any_dtype(_c) or pd.api.types.is_timedelta64_dtype(_c)):',
    '                _a = _c.to_numpy()',
    '                _f = _a.astype("int64").astype("float64")',
    '                _f[_np.isnat(_a)] = _np.nan',
    '                _vals[_i] = _f',
    '                _grp[_i] = "datetime" if pd.api.types.is_datetime64_any_dtype(_c) else "timedelta"',
    '            elif _do_cat and isinstance(_c.dtype, pd.CategoricalDtype) and _c.dtype.ordered:',
    '                _codes = _c.cat.codes.to_numpy().astype("float64")',
    '                _codes[_codes < 0] = _np.nan',
    '                _vals[_i] = _codes',
    '                _grp[_i] = "categorical"',
    '                _fixed[_i] = (0.0, float(len(_c.dtype.categories) - 1))',
    '        def _grange(_g):',
    '            _members = [_vals[_i] for _i in range(_ncols) if _grp[_i] == _g]',
    '            if not _members:',
    '                return None',
    '            _s = _np.concatenate([_m[_np.isfinite(_m)] for _m in _members])',
    '            return (float(_s.min()), float(_s.max())) if _s.size else None',
    '        _ranges = {_g: _grange(_g) for _g in ("num", "datetime", "timedelta")}',
    // Unordered/text/bool columns are colored per value from the stacked bar\'s
    // palette (_nominfo[i]["vmap"]); tail values not in the map get the same gray
    // as the bar\'s "(other)". NaN/NaT stays uncolored. Only when a palette exists
    // (matplotlib present) and _do_text is on.
    '        _text_idx = [_i for _i in range(_ncols) if _do_text and _nominfo and _i < len(_nominfo) and _nominfo[_i] and _nominfo[_i]["vmap"]] if _nominfo else []',
    '        if _nrows and (any(_g is not None for _g in _grp) or _text_idx):',
    '            _cols = [[None] * _nrows for _ in range(_ncols)]',
    '            for _i in _text_idx:',
    '                _vm = _nominfo[_i]["vmap"]',
    '                _cols[_i] = [None if pd.isna(_v) else _vm.get(str(_v), "#888888") for _v in _raw.iloc[:, _i]]',
    '            for _i in range(_ncols):',
    '                if _grp[_i] is None:',
    '                    continue',
    '                _arr = _vals[_i]',
    '                _mask = _np.isfinite(_arr)',
    '                if not _mask.any():',
    '                    continue',
    '                if _fixed[_i] is not None:',
    '                    _lo, _hi = _fixed[_i]',
    '                elif _columnwise:',
    '                    _cf = _arr[_mask]',
    '                    _lo, _hi = float(_cf.min()), float(_cf.max())',
    '                else:',
    '                    _r = _ranges[_grp[_i]]',
    '                    if _r is None:',
    '                        continue',
    '                    _lo, _hi = _r',
    '                if _center and _grp[_i] not in ("datetime", "categorical"):',
    '                    _hi = max(abs(_lo), abs(_hi))',
    '                    _lo = -_hi',
    '                _denom = (_hi - _lo) or 1.0',
    '                _norm = _np.clip((_arr - _lo) / _denom, 0.0, 1.0)',
    '                _rgb = (_cmap(_norm)[:, :3] * 255).round().astype("int64")',
    '                _packed = (_rgb[:, 0] << 16) | (_rgb[:, 1] << 8) | _rgb[:, 2]',
    '                _hex = ["#%06x" % int(p) for p in _packed]',
    '                _cols[_i] = [h if m else None for h, m in zip(_hex, _mask)]',
    '            if any(any(c is not None for c in _col) for _col in _cols):',
    '                colors = [list(_row) for _row in zip(*_cols)]',
    '    except Exception:',
    '        colors = None',
    // Per-column dtype + coarse kind (for a type glyph + tooltip), aligned to
    // the final columns: index first, then each data column.
    '    column_types = None',
    '    try:',
    '        def _kind(_x):',
    '            if pd.api.types.is_bool_dtype(_x):',
    '                return "bool"',
    '            if pd.api.types.is_datetime64_any_dtype(_x):',
    '                return "datetime"',
    '            if pd.api.types.is_timedelta64_dtype(_x):',
    '                return "timedelta"',
    '            if isinstance(getattr(_x, "dtype", _x), pd.CategoricalDtype):',
    '                return "categorical"',
    '            if pd.api.types.is_numeric_dtype(_x):',
    '                return "numeric"',
    '            if pd.api.types.is_string_dtype(_x):',
    '                return "text"',
    '            return "other"',
    '        if isinstance(_raw.index, pd.MultiIndex):',
    '            column_types = [{"dtype": "object", "kind": "other"}]',
    '        else:',
    '            column_types = [{"dtype": str(_raw.index.dtype), "kind": _kind(_raw.index)}]',
    '        for _i in range(_raw.shape[1]):',
    '            _col = _raw.iloc[:, _i]',
    '            column_types.append({"dtype": str(_col.dtype), "kind": _kind(_col)})',
    '    except Exception:',
    '        column_types = None',
    '    print(\'{"total": %d, "indexName": %s, "table": %s, "colors": %s, "columnTypes": %s, "stats": %s, "filterHint": %s, "filterError": %s}\'',
    '          % (total, json.dumps(index_name), table, json.dumps(colors), json.dumps(column_types), json.dumps(stats), json.dumps(filter_hint), json.dumps(_filter_error)))',
    '',
    '_VSCODE_dataviewer_dump()',
    'del _VSCODE_dataviewer_dump',
  ].join('\n');
}

/** Expression reading a CSV/TSV file with delimiter sniffing (",;\t|"). */
export function csvReadExpression(fsPath: string): string {
  // A JSON string literal is also a valid Python string literal.
  return `_read_csv(${JSON.stringify(fsPath)})`;
}

/** Expression reading a Parquet file (needs pyarrow/fastparquet in the env). */
export function parquetReadExpression(fsPath: string): string {
  return `pd.read_parquet(${JSON.stringify(fsPath)})`;
}

/** Expression reading a Feather/Arrow IPC file (needs pyarrow in the env). */
export function featherReadExpression(fsPath: string): string {
  return `pd.read_feather(${JSON.stringify(fsPath)})`;
}

/** Expression reading a JSON Lines file (one record per line); no extra dep. */
export function jsonLinesReadExpression(fsPath: string): string {
  return `pd.read_json(${JSON.stringify(fsPath)}, lines=True)`;
}

/**
 * Extracts the payload from captured stdout. Tolerates stray prints before
 * ours by falling back to the last non-empty line.
 */
export function parsePayload(stdout: string): DumpPayload {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Python returned no data.');
  }
  try {
    return JSON.parse(trimmed) as DumpPayload;
  } catch {
    const lines = trimmed.split('\n').filter((l) => l.trim() !== '');
    return JSON.parse(lines[lines.length - 1]) as DumpPayload;
  }
}

export interface TableContent {
  /**
   * Column headers. The first entry is the DataFrame index ("" when the index
   * is unnamed); the rest are the data columns. Each row in `rows` follows the
   * same layout, so the index always rides along as column 0.
   */
  columns: string[];
  rows: string[][];
  /**
   * Per-cell background colors aligned to `rows` (the index column,
   * like the header, gets a leading null since it is never colored). null when
   * Colorize is off.
   */
  colors: (string | null)[][] | null;
  /** Per-column dtype info aligned to `columns` (index first), or null. */
  columnTypes: ColumnType[] | null;
  /** Per-column summary stats aligned to `columns` (index first), or null. */
  stats: ColumnStat[] | null;
  /** Total rows in the full (filtered) data, before truncation to MAX_ROWS. */
  total: number;
  /** Example query expression for the filter-hint placeholder, or null. */
  filterHint: string | null;
  /** pandas error message from a failed filter query, or null. */
  filterError: string | null;
  /** Status-bar notice when the data was truncated to MAX_ROWS. */
  note?: string;
}

export function toTable(payload: DumpPayload): TableContent {
  const { table } = payload;
  const format = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };

  const columns = [payload.indexName, ...table.columns];
  const rows = table.data.map((row, i) => [format(table.index[i]), ...row.map(format)]);
  // Prepend a null for the index column so colors line up with rows/columns.
  const colors = payload.colors ? payload.colors.map((row) => [null, ...row]) : null;
  const note =
    payload.total > table.data.length
      ? `showing first ${table.data.length.toLocaleString()} of ${payload.total.toLocaleString()} rows`
      : undefined;
  // columnTypes/stats already include the index at [0], so they line up with columns.
  return {
    columns,
    rows,
    colors,
    columnTypes: payload.columnTypes,
    stats: payload.stats,
    total: payload.total,
    filterHint: payload.filterHint,
    filterError: payload.filterError,
    note,
  };
}
