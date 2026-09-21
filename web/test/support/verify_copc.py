"""Check the tiny COPC test file with laspy (an independent LAZ reader) against the formula it was made from, and check that the generator
(make_copc.py) still produces exactly the committed file.

usage: verify_copc.py <the committed test/fixtures/tiny.copc.laz> <the same file freshly generated>
"""
import sys

import laspy
import numpy as np

committed, fresh = sys.argv[1], sys.argv[2]
problems = []
if open(committed, 'rb').read() != open(fresh, 'rb').read():
    problems.append('the generator no longer makes the committed file (rerun make_copc.py and commit the result)')

las = laspy.read(committed)
X0, Y0 = 4914999.99, 3974999.99
if len(las.points) != 10000:
    problems.append(f'{len(las.points)} points')
if las.header.version.major != 1 or las.header.version.minor != 4 or las.header.point_format.id != 6:
    problems.append(f'version {las.header.version} format {las.header.point_format.id}')

# every point of the 100 x 100 lattice, 50 ft apart, at the height the formula gives (heights are stored to 0.01 ft)
i = np.round((las.x - X0) / 50 - 0.5).astype(int)
j = np.round((las.y - Y0) / 50 - 0.5).astype(int)
if len({(a, b) for a, b in zip(i, j)}) != 10000 or i.min() != 0 or i.max() != 99 or j.min() != 0 or j.max() != 99:
    problems.append('the points are not the 100 x 100 lattice')
x = X0 + (i + 0.5) * 50
y = Y0 + (j + 0.5) * 50
building = (np.abs(x - (X0 + 2500)) < 300) & (np.abs(y - (Y0 + 2500)) < 300)
z = 420 + 20 * np.sin((x - X0) / 700) * np.cos((y - Y0) / 900) + np.where(building, 40, 0)
if np.abs(las.z - z).max() > 0.006:
    problems.append(f'heights differ from the formula by up to {np.abs(las.z - z).max()}')
if not (np.array(las.classification)[building] == 6).all() or not (np.array(las.classification)[~building] == 2).all():
    problems.append('classes')
if problems:
    print('\n'.join(problems))
    sys.exit(1)
print('OK: laspy reads the tiny COPC file, and it is what the generator makes')
