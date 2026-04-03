from typing import Annotated, Any

from pydantic import BaseModel as _BaseModel, BeforeValidator, \
    PlainSerializer, WithJsonSchema, AfterValidator, Field
from pydantic_core import core_schema
from shapely import LineString


class BaseModel(_BaseModel):
    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True

    def model_dump_json(self, *args, **kwargs):
        return _BaseModel.model_dump(self, *args, by_alias=True, **kwargs)


class PydanticLineString(LineString):
    @classmethod
    def __get_pydantic_core_schema__(cls, _source_type: Any, _handler):
        def validate(value: list, _info):
            return cls(value)

        def serialize(value: LineString):
            return [list(coord) for coord in value.coords]

        return core_schema.no_info_wrap_validator_function(
            validate,
            schema=core_schema.any_schema(),
            serialization=core_schema.plain_serializer_function_ser_schema(
                serialize,
                return_schema=core_schema.list_schema(core_schema.list_schema(core_schema.float_schema()))
            )
        )


class LineFeature(BaseModel):
    line: PydanticLineString = Field(alias="l")
    grade: float = Field(alias="g")


class LineFeatureCollection(BaseModel):
    features: list[LineFeature]
