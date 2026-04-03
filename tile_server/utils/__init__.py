import asyncio
import itertools
import math
from datetime import datetime, timezone
from numbers import Number

from geopy.distance import geodesic


def coord_to_tile(lat_deg: float, lon_deg: float, zoom: int):
    lat_rad = math.radians(lat_deg)
    n = 1 << zoom
    x_tile = int((lon_deg + 180.0) / 360.0 * n)
    y_tile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return x_tile, y_tile


def tile_to_coord(x_tile: int | float, y_tile: int | float, zoom: int):
    """Returns (latitude, longitude)"""

    n = 1 << zoom
    lon_deg = x_tile / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y_tile / n)))
    lat_deg = math.degrees(lat_rad)
    return lat_deg, lon_deg


def flatten_line(coordinates):
    coords_list = coordinates

    while not isinstance(coords_list[0][0], Number):
        coords_list = list(itertools.chain(*coords_list))

    return coords_list


def flatten_all_lines(input_geo):
    lines = []

    for feature in input_geo['features']:
        if feature["geometry"]["type"] == "Point":
            continue

        coords = flatten_line(feature['geometry']['coordinates'])
        lines.append(coords)

    return lines


def geodesic_line_length(coords) -> float:
    """Takes (lon, lat) coords"""

    length = 0
    for i in range(len(coords) - 1):
        length += geodesic(reversed(coords[i]), reversed(coords[i + 1])).meters

    return length


def utcnow():
    return datetime.now(timezone.utc)


def async_exec(async_func, *args, **kwargs):
    return asyncio.run(async_func(*args, **kwargs))
