from __future__ import annotations

import asyncio

import asyncpg
import redis.asyncio as aioredis

from .config import Settings

TIMEOUT_S = 2.0


async def _pg(url: str) -> str:
    conn = await asyncpg.connect(url, timeout=TIMEOUT_S)
    try:
        await conn.fetchval("SELECT 1")
    finally:
        await conn.close()
    return "ok"


async def _redis(url: str) -> str:
    client = aioredis.from_url(url, socket_timeout=TIMEOUT_S)
    try:
        await client.ping()
    finally:
        await client.aclose()
    return "ok"


async def check(settings: Settings) -> dict[str, str]:
    async def run(name: str, url: str | None, fn) -> tuple[str, str]:
        if not url:
            return name, "not_configured"
        try:
            return name, await asyncio.wait_for(fn(url), TIMEOUT_S + 1)
        except Exception as e:
            return name, f"error: {type(e).__name__}"

    results = await asyncio.gather(
        run("postgres", settings.database_url, _pg),
        run("redis", settings.redis_url, _redis),
    )
    return dict(results)
