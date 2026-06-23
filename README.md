# DataFrame Viewer

View tabular Jupyter variables and data files.

![DataFrame Viewer with default settings](images/default-settings.webp)

## Main Features

- View data in a **tabular grid** with sticky index and column headers.
- **Sort** with multiple keys.
- Look at **missing value ratios** and the distribution **plots** (histogram or stacked bar).
- **Filter** using [Pandas' query syntax](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.query.html).
- **Quick filter** data by clicking in the plots.
- **Colorize** cells and graphs.

## Usage

### View Data

Load Jupyter variables, when executing a Jupyter notebook or a Python script with the interactive window. You need to grant kernel access once.

![Load Jupyter variable with Data viewer](images/open-jupyter-variable.webp)

View variables in debug mode and open files. *Note: Data types are not inferred from CSV or TSV files.*

![Left: Mouse pointing at "View Value in DataFrame Viewer" in debug variable context menu, right: mouse pointing at "Open in DataFrame Viewer" in CSV file context menu](images/open-from-debugger-and-file.webp)

### Sort

Stable sort with multiple keys (last has priority).

![Sort data using multiple columns](images/sort.webp)

### Stats

Missing value ratios and distribution plots.

![Missing value bars and distribution plots](images/stats.webp)

### Filter

Filter data using [Pandas' query syntax](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.query.html). Add filter expressions by clicking into the plots. Multiple filters are appended with Operator `&`.

![Filter data by germany and last_census dates](images/filter.webp)

### Colorize

Colorize cells and histograms with columnwise or global vmin/vmax for numeric columns, optionally symmetrically centered around 0.

![Colorize cells and histograms](images/colorize.webp)

## Requirements

This extension requires:

- Python with
  - Pandas
  - NumPy
  - Matplotlib (for colorize feature)
  - PyArrow (for `*.parquet`, `*.feather` import)
- VS Code extensions
  - Python
  - Jupyter

## License

[MIT](LICENSE)
