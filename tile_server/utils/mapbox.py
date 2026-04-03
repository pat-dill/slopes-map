import httpx
from PIL import Image

from tile_server.config import env_config
from tile_server.exceptions import TileServerException

def get_cache_path(tileset, x, y, z, x2=True):
    tile_cache = env_config.cache_dir / "mapbox" / tileset
    tile_cache.mkdir(parents=True, exist_ok=True)
    return tile_cache / f"{tileset}_{z}_{x}_{y}{'_2x' if x2 else ''}.png"


def get_remote_mapbox_tile(tileset, x, y, z, x2=True):
    url = f"https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}{'@2x' if x2 else ''}.pngraw"
    resp = httpx.get(url, params=dict(access_token=env_config.mapbox_token))

    if not resp.is_success:
        raise TileServerException(resp.text)

    img = Image.open(resp, formats=["png"])
    img.save(str(get_cache_path(tileset, x, y, z, x2)))

    return img


def get_mapbox_tile(tileset, x, y, z, x2=True):
    """Returns Pillow Image for tile."""

    cached_tile_path = get_cache_path(tileset, x, y, z, x2)
    if cached_tile_path.is_file():
        return Image.open(str(cached_tile_path))

    else:
        return get_remote_mapbox_tile(tileset, x, y, z, x2=x2)
