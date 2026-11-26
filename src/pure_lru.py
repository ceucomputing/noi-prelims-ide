"""Make functools.lru_cache and functools.cache safe for deep recursion.

By default, these decorators use a wrapper written in C. Each call through that wrapper uses space on the
browser's small native stack, so deep recursion through a cached function crashes. Python also has a
wrapper written in Python, which runs inside the interpreter and uses no native stack. This module makes
functools use that one.
"""

import _functools
import functools
import importlib
import sys
import types

_without_c_wrapper = types.ModuleType("_functools")
_without_c_wrapper.__dict__.update(
    {name: value for name, value in vars(_functools).items() if name != "_lru_cache_wrapper"}
)
sys.modules["_functools"] = _without_c_wrapper
importlib.reload(functools)
del _without_c_wrapper
