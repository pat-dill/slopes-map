import os
from pathlib import Path
from pydantic import BaseModel


# Environment variables config

class _EnvConfig(BaseModel):
    class Config:
        alias_generator = str.upper
        populate_by_name = True

    cache_dir: Path = Path.home() / ".tile_server_cache"
    mapbox_token: str = ""
    overpass_api: str = "https://lambert.openstreetmap.de/api/interpreter"
    user_agent: str = ""
    max_zoom_level: int = 13
    min_zoom_level: int = 13
    min_combined_zoom_level: int = 12

    redis_host: str = "localhost"
    redis_port: str = 6379
    redis_username: str = "default"

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "username"
    postgres_password: str = "password"
    postgres_db: str = "postgres"

    version: str = "0.1"


env_config = _EnvConfig.model_validate(os.environ)
