import sys
from collections import OrderedDict


class LRUCache:
    def __init__(self, maxsize=128):
        self.maxsize = maxsize
        self._cache = OrderedDict()

    def get(self, key, default=None):
        if key in self._cache:
            # Move to end to mark as recently used
            self._cache.move_to_end(key)
            return self._cache[key]
        return default

    def set(self, key, value):
        if key in self._cache:
            # Update existing key and mark as recently used
            self._cache.move_to_end(key)
        self._cache[key] = value
        if len(self._cache) > self.maxsize:
            # Pop oldest item
            self._cache.popitem(last=False)

    def __getitem__(self, key):
        return self.get(key)

    def __setitem__(self, key, value):
        self.set(key, value)

    def __contains__(self, key):
        return key in self._cache

    def __len__(self):
        return len(self._cache)



