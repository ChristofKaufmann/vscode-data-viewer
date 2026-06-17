# %% imports
import numpy as np
import matplotlib.pyplot as plt

# %% logo

rng = np.random.default_rng(0)

# circular markers
angles = np.arange(0, 360, 60)
x = np.cos(angles * np.pi / 180)
y = np.sin(angles * np.pi / 180)

# center marker
x = np.append(x, 0)
y = np.append(y, 0)

# colors (center yellow)
c = rng.random(x.shape)
c[-1] = 1

# plot and export
fig, ax = plt.subplots(figsize=(2, 2))
plt.scatter(x, y, s=1150, c=c, marker='h')
plt.axis('equal')
plt.axis('off')
plt.xlim(-1.4, 1.4)
# fig.savefig('logo.svg', transparent=True, bbox_inches='tight')  # SVG not allowed in Marketplace
fig.savefig('logo.png', transparent=True, bbox_inches='tight')

# POST-PROCESSING:
# convert logo.png -trim logo.png
