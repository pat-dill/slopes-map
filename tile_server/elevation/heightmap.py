from tile_server.utils.cache import LRUCache
from tile_server.utils.mapbox import get_mapbox_tile

TILESET = "mapbox.mapbox-terrain-dem-v1"

heightmap_cache = LRUCache(maxsize=128)


def get_heightmap(x, y, z):
    cache_key = f"{TILESET}/{x}/{y}/{z}"
    if cache_key in heightmap_cache:
        return heightmap_cache[cache_key]

    img = get_mapbox_tile(TILESET, x, y, z)

    if not img:
        raise ValueError("no image")

    heightmap = {}
    pixels = img.load()
    for px in range(512):
        for py in range(512):
            r, g, b, _ = pixels[px, py]
            elevation = -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1)
            elevation = round(elevation * 10) / 10
            heightmap[(px, py)] = elevation

    heightmap_cache[cache_key] = heightmap
    return heightmap
