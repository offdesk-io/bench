"""Where the Bench checkout and its sibling PACKAGES and notify folders are.

$BENCH_ROOT moves the checkout root, $BENCH_PACKAGES the packages folder and
$NOTIFY_HOME the notifier's, for a deployment whose layout is not the one on
the owner's Mac. With none set the
answers are the ones the code always worked out: the folder above core/, and
PACKAGES and notify beside it. Kept to the standard library so any entry point can import it
before its own path set-up.
"""

import os


def root():
    return os.environ.get("BENCH_ROOT") or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))


def packages():
    return os.environ.get("BENCH_PACKAGES") or os.path.normpath(
        os.path.join(root(), "..", "PACKAGES"))


def notify_home():
    """The notifier's folder (its queues and poster), beside the checkout.
    There or not: core/notify_due.py checks before using it."""
    return os.environ.get("NOTIFY_HOME") or os.path.normpath(
        os.path.join(root(), "..", "notify"))
