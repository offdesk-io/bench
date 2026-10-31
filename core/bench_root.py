"""Where the Bench checkout and its sibling PACKAGES folder are.

$BENCH_ROOT moves the checkout root and $BENCH_PACKAGES the packages folder, for
a deployment whose layout is not the one on the owner's Mac. With neither set the
answers are the ones the code always worked out: the folder above core/, and
PACKAGES beside it. Kept to the standard library so any entry point can import it
before its own path set-up.
"""

import os


def root():
    return os.environ.get("BENCH_ROOT") or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))


def packages():
    return os.environ.get("BENCH_PACKAGES") or os.path.normpath(
        os.path.join(root(), "..", "PACKAGES"))
