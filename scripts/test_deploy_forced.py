#!/usr/bin/env python3
"""Proof that deploy-forced-command.sh, the only thing the pipeline's deploy key
can run, deploys one full commit id and refuses everything else.

It points BENCH_DEPLOY_SCRIPT at a stub that records its arguments, so nothing
is deployed. sshd's `restrict` stops a real client from setting that variable.

    python3 scripts/test_deploy_forced.py
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FORCED = os.path.join(HERE, "deploy-forced-command.sh")
SHA = "0123456789abcdef0123456789abcdef01234567"

FAILED = []


def check(name, got, want):
    ok = got == want
    print(("  ok  " if ok else " FAIL ") + " " + name)
    if not ok:
        FAILED.append("%s\n    got  %r\n    want %r" % (name, got, want))


def run(original_command):
    """(exit code, the stub's BENCH_DEPLOY_ONLY_ON and arguments, or None)."""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "args")
        stub = os.path.join(tmp, "stub.sh")
        with open(stub, "w") as fh:
            fh.write('#!/usr/bin/env bash\n'
                     'printf "%%s\\n" "${BENCH_DEPLOY_ONLY_ON-unset} $*" > "%s"\n' % out)
        env = dict(os.environ, BENCH_DEPLOY_SCRIPT=stub)
        if original_command is None:
            env.pop("SSH_ORIGINAL_COMMAND", None)
        else:
            env["SSH_ORIGINAL_COMMAND"] = original_command
        rc = subprocess.run(["bash", FORCED], env=env, capture_output=True).returncode
        got = open(out).read().strip() if os.path.exists(out) else None
        return rc, got


def test_a_full_commit_id_is_deployed_with_apply():
    rc, got = run(SHA)
    check("a commit id exits 0", rc, 0)
    check("it runs the deploy with apply=1 on the real paths, only from main",
          got, "main 1 /opt/agency/bench /opt/agency/PACKAGES " + SHA)


def test_anything_else_is_refused_and_nothing_runs():
    for name, cmd in [
        ("no command (an interactive login)", None),
        ("an empty command", ""),
        ("a shell", "bash"),
        ("a branch name", "main"),
        ("a short commit id", SHA[:9]),
        ("an uppercase commit id", SHA.upper()),
        ("a commit id with more after it", SHA + "; rm -rf /"),
        ("a commit id with a space after it", SHA + " "),
        ("a commit id with a newline after it", SHA + "\nbash"),
    ]:
        rc, got = run(cmd)
        check(name + " is refused", (rc, got), (2, None))


def main():
    test_a_full_commit_id_is_deployed_with_apply()
    test_anything_else_is_refused_and_nothing_runs()
    print()
    if FAILED:
        for f in FAILED:
            print("FAIL " + f)
        print("%d failed" % len(FAILED))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
