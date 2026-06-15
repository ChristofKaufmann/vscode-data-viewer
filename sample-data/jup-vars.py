# %%
# Sample variables for trying out the Data Viewer.
#
# Run these cells in a Jupyter kernel (VS Code's interactive window works well),
# from this `sample-data` folder so the relative CSV path resolves. Then open
# each variable from the Jupyter VARIABLES panel via the Data Viewer icon. Each
# cell exercises a different feature.
import numpy as np
import pandas as pd

# %%
# Mixed DataFrame: numeric, string, parsed datetime, and an ordered categorical.
# Numeric columns and `last_census` get a heatmap; `size_class` is colored by
# rank. "Very Small" has no rows yet still reserves the darkest slot, since
# ordered categoricals are ranked over their full set of categories.
cities = pd.read_csv("cities.csv", parse_dates=["last_census"])
cities["size_class"] = pd.Categorical(
    cities["size_class"],
    categories=["Very Small", "Small", "Medium", "Large", "Megacity"],
    ordered=True,
)
cities

# %%
# DatetimeIndex — shown as the leftmost column, labelled "last_census".
cities_by_date = cities.dropna(subset=["last_census"]).set_index("last_census")
cities_by_date

# %%
# MultiIndex — its level names join in the index column header ("country, city").
cities_multi = cities.set_index(["country", "city"])
cities_multi

# %%
# A Series (rendered as a single-column table).
population = cities.set_index("city")["population"]
population

# %%
# A 2-D ndarray — no headers, columns are 0..n.
matrix = np.linspace(-1.0, 1.0, 25).reshape(5, 5)
matrix

# %%
# Signed values for the "Center at 0" toggle: pick a diverging colormap
# (e.g. coolwarm) and enable Center so 0 maps to the neutral midpoint.
signed = pd.DataFrame(
    np.random.default_rng(0).normal(size=(8, 4)).round(2),
    columns=["a", "b", "c", "d"],
)
signed

# %%
# A timedelta column (colored like datetimes, but centering applies — there's a
# negative duration here). Try "Center at 0" with a diverging colormap.
durations = pd.DataFrame(
    {
        "task": ["build", "test", "deploy", "rollback"],
        "elapsed": pd.to_timedelta([150, 310, 65, -45], unit="s"),
    }
)
durations

# %%
# Round-trip parquet format and see if dtypes are preserved
parquet_path = 'cities.parquet'
durations.to_parquet(parquet_path)
durations_p = pd.read_parquet(parquet_path)
