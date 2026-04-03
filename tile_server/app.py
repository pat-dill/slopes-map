import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent))

from concurrent.futures import as_completed, Future
from concurrent.futures.process import ProcessPoolExecutor
from concurrent.futures.thread import ThreadPoolExecutor

import mercantile
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, FileResponse

from tile_server import models
from tile_server.config import env_config
from tile_server.exceptions import ErrorResponse
from tile_server.tileset import get_line_grades_for_tile, line_strings_to_mvt, OverpassException

api = FastAPI()
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@api.get("/tiles/{z}/{x}/{y}.pbf")
def get_tile(z: int, x: int, y: int):
    if not env_config.min_combined_zoom_level <= z <= env_config.max_zoom_level:
        return Response(status_code=204)

    cache_path = env_config.cache_dir / f"tiles-{env_config.version}" / f"{z}/{x}_{y}.pbf"
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    if cache_path.is_file():
        return FileResponse(cache_path, media_type="application/vnd.mapbox-vector-tile")

    try:
        with ProcessPoolExecutor(max_workers=12) as pool:
            if z >= env_config.min_zoom_level:
                line_grades = get_line_grades_for_tile(x, y, z)
                mvt_tile = line_strings_to_mvt(line_grades, x, y, z)
                ThreadPoolExecutor(max_workers=1).submit(cache_path.write_bytes, mvt_tile)
                return Response(mvt_tile, media_type="application/vnd.mapbox-vector-tile")
            else:
                # load data for multiple tiles and combine into one mvt (min_combined_zoom_level)

                tiles = [mercantile.Tile(x, y, z)]
                for i in range(env_config.min_zoom_level - z):
                    tiles = [
                        child
                        for tile in tiles
                        for child in mercantile.children(tile)
                    ]

                feature_col_futures: list[Future[models.LineFeatureCollection]] = [
                    pool.submit(get_line_grades_for_tile, tile.x, tile.y, tile.z)
                    for tile in tiles
                ]

                mvt_tile = line_strings_to_mvt(models.LineFeatureCollection(
                    features=[
                        line_feature
                        for feature_col_future in as_completed(feature_col_futures)
                        for line_feature in feature_col_future.result().features
                    ]
                ), x, y, z)

                cache_path.write_bytes(mvt_tile)
                return Response(mvt_tile, media_type="application/vnd.mapbox-vector-tile")
    except (OverpassException, TimeoutError):
        return Response(status_code=500)


@api.exception_handler(ErrorResponse)
def handle_err_response(request: Request, exc: ErrorResponse) -> JSONResponse:
    return JSONResponse(
        status_code=exc.code,
        content={
            "success": False,
            "status": exc.code,
            "message": exc.message,
        }
    )
