# %%
import pandas as pd
df = pd.read_csv('cities.csv')
df = df.set_index('city')

# %%
df = df.set_index(['city', 'country'])
