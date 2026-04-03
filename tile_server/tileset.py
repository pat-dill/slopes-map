import math
from collections import defaultdict
from typing import Any

import geohash
import httpx
import mapbox_vector_tile
import mercantile
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry
from shapely.geometry.linestring import LineString
from shapely.ops import substring
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from tile_server import models
from tile_server.config import env_config
from tile_server.db.sql_schemas import TileFeatures
from tile_server.db.sqlalchemy_context import db_client
from tile_server.elevation.get_elevation import ele_at_coord
from tile_server.overpass_queries import queries
from tile_server.utils.quantize import quantize_coords
from tile_server.utils import geodesic_line_length


# exceptions


class OverpassException(Exception):
    pass


# Coordinate transforms
LAYER_NAME = "gradient"


class OsmLineGraph:
    def __init__(self):
        self.lines: set[BaseGeometry] = set()
        self.points_map: dict[str, set[BaseGeometry]] = defaultdict(set)

    def add(self, *lines):
        for maybe_multi_line in lines:
            if maybe_multi_line.geom_type == "LineString":
                to_add = [maybe_multi_line]
            elif maybe_multi_line.geom_type == "MultiLineString":
                to_add = maybe_multi_line.geoms
            else:
                raise ValueError(maybe_multi_line.type)

            for line in to_add:
                self.lines.add(line)
                for point in line.coords:
                    self.points_map[hash_p(point)].add(line)

    def remove(self, line):
        if line in self.lines:
            self.lines.remove(line)

        for point in line.coords:
            if line in self.points_map[hash_p(point)]:
                self.points_map[hash_p(point)].remove(line)


def hash_p(point: tuple[float, float]):
    return geohash.encode(*reversed(point), precision=12)


def get_overpass_data(x: int, y: int, z: int) -> list[Any]:
    bbox = mercantile.bounds(mercantile.Tile(x, y, z))
    query = queries[z].replace("({{bbox}})", str((bbox.south, bbox.west, bbox.north, bbox.east)))
    resp = httpx.post(
        env_config.overpass_api,
        content=query,
        headers={"User-Agent": env_config.user_agent}
    )

    try:
        return resp.json()["elements"]
    except:
        raise OverpassException(f"Overpass request failed: {resp.text}")


def normalize_geojson_lines(features: list[Any], x: int, y: int, z: int) -> OsmLineGraph:
    bounds = mercantile.bounds(mercantile.Tile(x, y, z))
    bbox_poly = box(bounds.west, bounds.south, bounds.east, bounds.north)

    network = OsmLineGraph()

    # convert all features to shapely lines and clip to tile
    for feat in features:
        if feat["type"] != "way":
            continue

        geom = LineString([
            (point["lon"], point["lat"])
            for point in feat["geometry"]
        ])

        clipped = geom.intersection(bbox_poly)
        if clipped.is_empty:
            continue

        if clipped.geom_type == "LineString":
            to_add = [clipped]
        elif clipped.geom_type == "MultiLineString":
            to_add = list(clipped.geoms)
        else:
            to_add = []

        network.add(*to_add)

    # split lines so that no lines share midpoints

    process_stack = list(network.lines.copy())
    while process_stack:
        line = process_stack.pop()

        max_seg_len = 20 * (2 ** (14 - z))

        # Keep max line segment under certain length
        line_segments = math.floor(geodesic_line_length(line.coords) / max_seg_len) + 1
        if line_segments > 1:
            new_lines = []
            for i in range(0, line_segments):
                start = i / line_segments
                end = (i + 1) / line_segments
                new_line = substring(line, start, end, normalized=True)
                new_lines.append(new_line)

            # Use Shapely's split function
            network.remove(line)
            network.add(*new_lines)
            # process_stack.extend(new_lines)

    return network


def get_line_grades_for_network(network: OsmLineGraph) -> models.LineFeatureCollection:
    line_grades = []
    for line in network.lines:
        length = geodesic_line_length(line.coords)
        ele_start = ele_at_coord(line.coords[0][1], line.coords[0][0])
        ele_end = ele_at_coord(line.coords[-1][1], line.coords[-1][0])
        grade = abs((ele_start - ele_end) / length) * 100

        line_grades.append(models.LineFeature(line=line, grade=grade))

    return models.LineFeatureCollection(features=line_grades)


def get_line_grades_for_tile(x: int, y: int, z: int):
    with db_client.session() as session:
        cached_tile_res = session.execute(
            select(TileFeatures)
            .where(
                TileFeatures.x == x,
                TileFeatures.y == y,
                TileFeatures.z == z,
                TileFeatures.version == env_config.version,
            )
            .limit(1)
        )
        cached_tile = cached_tile_res.scalar_one_or_none()

    if cached_tile is None:
        geojson_elements = get_overpass_data(x, y, z)
        line_network = normalize_geojson_lines(geojson_elements, x, y, z)
        line_grades = get_line_grades_for_network(line_network)

        with db_client.session() as session:
            session.execute(
                insert(TileFeatures)
                .values(
                    x=x,
                    y=y,
                    z=z,
                    features=line_grades.model_dump_json(),
                )
                .on_conflict_do_nothing()
            )
            session.commit()

        return get_line_grades_for_network(line_network)
    else:
        return models.LineFeatureCollection.model_validate(cached_tile.features)


def line_strings_to_mvt(line_features: models.LineFeatureCollection, x: int, y: int, z: int):
    return mapbox_vector_tile.encode({
        "name": LAYER_NAME,
        "features": [
            {
                "geometry": str(LineString([
                    quantize_coords(coord[0], coord[1], x, y, z)
                    for coord in line.line.coords
                ])),
                "properties": {
                    "grade": line.grade,
                }
            }
            for line in line_features.features
        ],
    })
