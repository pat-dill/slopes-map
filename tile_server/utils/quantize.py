import math

R = 6378137.0  # Earth's radius in meters


def lonlat_to_mercator(lon: float, lat: float) -> tuple[float, float]:
    x = R * math.radians(lon)
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def tile_bounds_mercator(x: int, y: int, z: int) -> tuple[float, float, float, float]:
    initial_res = 2 * math.pi * R / 256  # resolution at zoom 0
    res = initial_res / (2 ** z)

    minx = x * 256 * res - math.pi * R
    maxx = (x + 1) * 256 * res - math.pi * R
    maxy = math.pi * R - y * 256 * res
    miny = math.pi * R - (y + 1) * 256 * res
    return minx, miny, maxx, maxy


def quantize_coords(lon: float, lat: float, x: int, y: int, z: int, extent: int = 4096) -> tuple[int, int]:
    mx, my = lonlat_to_mercator(lon, lat)
    minx, miny, maxx, maxy = tile_bounds_mercator(x, y, z)

    qx = int((mx - minx) / (maxx - minx) * extent)
    qy = int((my - miny) / (maxy - miny) * extent)  # flip y-axis for vector tile spec
    return qx, qy
