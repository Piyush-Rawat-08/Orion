import random
import string

import pytest

from orion import db as dbm
from orion import epoch as ep
from orion import load
from orion.world import corvane


@pytest.fixture(scope="session")
def db():
    return dbm.get_db()


def fresh_tenant(db) -> str:
    """Load Corvane under a throwaway tenant name, so tests never touch the demo graphs."""
    t = "test-" + "".join(random.choices(string.ascii_lowercase, k=6))
    w = corvane.build()
    w.tenant = t
    load.load(db, w)
    ep.now(db, t)
    return t


def drop(db, t: str) -> None:
    for g in db.graphs(f"org:{t}") + db.graphs(f"epoch:{t}:") + db.graphs(f"universe:{t}:") + \
            db.graphs(f"deck:{t}") + db.graphs(f"mem:{t}:"):
        db.delete(g)
    for prefix in (f"orion:{t}:", f"orion:epoch:epoch:{t}:", f"orion:snap:epoch:{t}:", f"orion:deck-indexed:deck:{t}"):
        db.drop(prefix)


@pytest.fixture
def tenant(db):
    t = fresh_tenant(db)
    yield t
    drop(db, t)
