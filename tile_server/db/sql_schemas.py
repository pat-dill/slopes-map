from datetime import datetime

from sqlalchemy import (
    MetaData,
    Text,
    BigInteger,
    LargeBinary
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy_utc import UtcDateTime
from sqlalchemy_utils import force_instant_defaults

from tile_server.config import env_config
from tile_server.utils import utcnow

DBMeta = MetaData()

force_instant_defaults()


# assert DBMeta.schema


class DBModel(DeclarativeBase):
    metadata = DBMeta
    type_annotation_map = {
        datetime: UtcDateTime,
        str: Text,
        int: BigInteger,
        bytes: LargeBinary,
        dict: JSONB,
    }


class TileFeatures(DBModel):
    __tablename__ = "tile_features"

    x: Mapped[int] = mapped_column(primary_key=True)
    y: Mapped[int] = mapped_column(primary_key=True)
    z: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[str] = mapped_column(primary_key=True, default=env_config.version)

    features: Mapped[dict] = mapped_column()

    created_at: Mapped[datetime] = mapped_column(default=utcnow)
