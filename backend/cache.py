import json
import time
from typing import Optional

import redis


class RedisCache:
    def __init__(self, redis_url: str):
        self._r = redis.Redis.from_url(redis_url, decode_responses=True)

    def get_json(self, key: str) -> Optional[dict]:
        v = self._r.get(key)
        if not v:
            return None
        return json.loads(v)

    def set_json(self, key: str, value: dict, ttl_seconds: int) -> None:
        self._r.set(key, json.dumps(value), ex=ttl_seconds)

    def delete(self, key: str) -> None:
        self._r.delete(key)

    def lock(self, key: str, ttl_seconds: int = 10):
        return self._r.lock(key, timeout=ttl_seconds)

