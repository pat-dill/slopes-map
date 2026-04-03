from contextlib import contextmanager, asynccontextmanager
from contextvars import ContextVar
from typing import TypeVar, Generic

from sqlalchemy import Engine, create_engine
from sqlalchemy.ext.asyncio import create_async_engine, AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import sessionmaker, Session

from tile_server.config import env_config

T = TypeVar('T')


class ContextStack(Generic[T]):
    ctx: ContextVar[tuple]

    def __init__(self, name: str):
        self.ctx = ContextVar(name, default=())

    @property
    def top(self) -> T | None:
        return self.ctx.get()[-1] if self.ctx.get() else None

    def push(self, value: T) -> T:
        self.ctx.set(self.ctx.get() + (value,))
        return value

    def pop(self) -> T | None:
        stack = self.ctx.get()
        self.ctx.set(stack[:-1])
        return stack[-1] if stack else None


class DBClient:
    """
    SQLAlchemy session factory that allows reusing [async] sessions in an execution context, for example a
    FastAPI/Flask request, coroutine, or thread.
    """

    def __init__(self, name="db_client", *, engine: Engine = None, async_engine: AsyncEngine = None):
        self._engine = engine
        self._async_engine = async_engine

        self._session_stack: ContextStack[Session] = ContextStack(f"{name}")
        self._async_session_stack: ContextStack[AsyncSession] = ContextStack(f"{name}_async")

        session_args = dict(
            autocommit=False,
            autoflush=False,
            expire_on_commit=False,
        )
        self._session_factory = sessionmaker(self._engine, **session_args)
        self._async_session_factory = async_sessionmaker(self._async_engine, **session_args)

    @classmethod
    def create_engine(cls, sync_url: str | None, name="db_client", *, async_url: str | None = None, **kwargs):
        return cls(
            name=name,
            engine=create_engine(sync_url, **kwargs) if sync_url else None,
            async_engine=create_async_engine(async_url, **kwargs) if async_url else None,
        )

    @contextmanager
    def session(self, *, isolated=False) -> Session:
        """
        Context manager that yields a Session. If called from within
        another `client.session()` block, it will reuse that session
        unless you pass isolated=True
        """

        if isolated or self._session_stack.top is None:
            session_obj = self._session_factory()
            self._session_stack.push(session_obj)

            try:
                yield session_obj
            finally:
                self._session_stack.pop()
                session_obj.close()
        else:
            yield self._session_stack.top

    @asynccontextmanager
    async def async_session(self, *, isolated=False) -> AsyncSession:
        """
        Context manager that yields an AsyncSession. If called from within
        another `client.async_session()` block, it will reuse that session
        unless you pass isolated=True
        """

        if isolated or self._async_session_stack.top is None:
            session_obj = self._async_session_factory()
            self._async_session_stack.push(session_obj)

            try:
                yield session_obj
            finally:
                self._async_session_stack.pop()
                await session_obj.aclose()

        else:
            yield self._async_session_stack.top


def get_db_url(driver, host, port, user, pw, db):
    return f"{driver}://{user}:{pw}@{host}:{port}/{db}"


db_client = DBClient.create_engine(
    sync_url=get_db_url(
        "postgresql+psycopg2",
        env_config.postgres_host,
        env_config.postgres_port,
        env_config.postgres_user,
        env_config.postgres_password,
        env_config.postgres_db
    ),
    async_url=get_db_url(
        "postgresql+asyncpg",
        env_config.postgres_host,
        env_config.postgres_port,
        env_config.postgres_user,
        env_config.postgres_password,
        env_config.postgres_db
    ),
    pool_size=30,
)
