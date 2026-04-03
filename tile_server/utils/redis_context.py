from contextlib import contextmanager, asynccontextmanager
from contextvars import ContextVar
from typing import TypeVar, Generic

import redis
import redis.asyncio as async_redis

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


class RedisClient:
    """
    SQLAlchemy session factory that allows reusing [async] sessions in an execution context, for example a
    FastAPI/Flask request, coroutine, or thread.
    """

    def __init__(self, name="redis_client", **kwargs):
        self._session_stack: ContextStack[redis.Redis] = ContextStack(f"{name}")
        self._async_session_stack: ContextStack[async_redis.Redis] = ContextStack(f"{name}_async")

        self.redis_kwargs = kwargs

    @contextmanager
    def session(self, *, isolated=False) -> redis.Redis:
        """
        Context manager that yields a Session. If called from within
        another `client.session()` block, it will reuse that session
        unless you pass isolated=True
        """

        if isolated or self._session_stack.top is None:
            session_obj = redis.Redis(**self.redis_kwargs)

            try:
                yield session_obj
            finally:
                self._session_stack.pop()
                session_obj.close()
        else:
            yield self._session_stack.top

    @asynccontextmanager
    async def async_session(self, *, isolated=False) -> async_redis.Redis:
        """
        Context manager that yields an AsyncSession. If called from within
        another `client.async_session()` block, it will reuse that session
        unless you pass isolated=True
        """

        if isolated or self._session_stack.top is None:
            session_obj = async_redis.Redis(**self.redis_kwargs)

            try:
                yield session_obj
            finally:
                self._session_stack.pop()
                await session_obj.aclose()
        else:
            yield self._session_stack.top


redis_client = RedisClient(
    host=env_config.redis_host,
    port=env_config.redis_port,
)
