from logging.config import fileConfig

from alembic import context
from alembic_utils.replaceable_entity import ReplaceableEntity, register_entities
from sqlalchemy import engine_from_config, MetaData
from sqlalchemy import pool

from tile_server.db import sql_schemas
from tile_server.config import env_config

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# set DB URL

pg_user = env_config.postgres_user
pg_pass = env_config.postgres_password
pg_host = env_config.postgres_host
pg_port = env_config.postgres_port
pg_db = env_config.postgres_db

section = config.config_ini_section
config.set_section_option(
    section,
    'sqlalchemy.url',
    f"postgresql+psycopg2://{pg_user}:{pg_pass}@{pg_host}:{pg_port}/{pg_db}"
)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
# from myapp import mymodel
# target_metadata = mymodel.Base.metadata
target_metadata: MetaData = sql_schemas.DBMeta
replaceable_entities: list[ReplaceableEntity] = []

for obj in vars(sql_schemas).values():
    if isinstance(obj, ReplaceableEntity):
        replaceable_entities.append(obj)

register_entities(replaceable_entities)


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        # compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
