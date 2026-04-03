import math

from tile_server.elevation.heightmap import get_heightmap
from tile_server.utils import coord_to_tile, tile_to_coord

ZOOM = 14


def get_alpha(x, min_val, max_val):
    return (x - min_val) / (max_val - min_val)


def lerp(a, b, alpha):
    return (b - a) * alpha + a


def ele_at_coord(lat: float, lon: float) -> float:
    x, y = coord_to_tile(lat, lon, ZOOM)
    height_data = get_heightmap(x, y, ZOOM)

    tl_lat, tl_lon = tile_to_coord(x, y, ZOOM)
    br_lat, br_lon = tile_to_coord(x + 1, y + 1, ZOOM)

    x_px = min(get_alpha(lon, tl_lon, br_lon) * 512, 511.99)
    y_px = min(get_alpha(lat, tl_lat, br_lat) * 512, 511.99)

    if x_px > 511 or y_px > 511:
        return height_data[(math.floor(x_px), math.floor(y_px))]

    tl = height_data[(math.floor(x_px), math.floor(y_px))]
    tr = height_data[(math.ceil(x_px), math.floor(y_px))]
    bl = height_data[(math.floor(x_px), math.ceil(y_px))]
    br = height_data[(math.ceil(x_px), math.ceil(y_px))]

    top_height = lerp(tl, tr, x_px % 1)
    bottom_height = lerp(bl, br, x_px % 1)
    return lerp(top_height, bottom_height, y_px % 1)
