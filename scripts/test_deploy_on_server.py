#!/usr/bin/env python3
"""Proof that deploy-on-server.sh, given BENCH_DEPLOY_ONLY_ON (which
deploy-forced-command.sh sets to main), deploys only a commit that branch has
reached, and that the manual route, which never sets it, is unchanged. Also
that each package packages.lock names at the deployed commit goes to the
commit it names, a package on the command line keeps its ref, a bad line
stops the deploy, and a failed deploy rolls the packages back too.

It runs the real script over throwaway git repos, with runuser, getent, flock,
npm, systemctl and curl stubbed on the PATH, so nothing is built or restarted.
The script needs bash 4 or later; with none found it skips, except on CI.

    python3 scripts/test_deploy_on_server.py
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "deploy-on-server.sh")

STUBS = {
    # runuser -u bench -- env HOME=... cmd: run the command as whoever we are.
    "runuser": 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"',
    "getent": 'echo "bench:x:1000:1000::$STUB_HOME:/bin/bash"',
    "flock": "exit 0",
    "npm": "exit 0",
    "systemctl": "exit 0",
    "curl": "printf 200",
}

FAILED = []


def check(name, got, want):
    ok = got == want
    print(("  ok  " if ok else " FAIL ") + " " + name)
    if not ok:
        FAILED.append("%s\n    got  %r\n    want %r" % (name, got, want))


def find_bash():
    for cand in [os.environ.get("BENCH_TEST_BASH"), "/opt/homebrew/bin/bash",
                 "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"]:
        if cand and os.path.exists(cand):
            r = subprocess.run([cand, "-c", "echo ${BASH_VERSINFO[0]}"],
                               capture_output=True, text=True)
            if r.returncode == 0 and int(r.stdout.strip() or 0) >= 4:
                return cand
    return None


def git(cwd, *args):
    return subprocess.run(["git", "-C", cwd, *args], check=True,
                          capture_output=True, text=True).stdout.strip()


def commit(repo, msg):
    with open(os.path.join(repo, "f.txt"), "a") as fh:
        fh.write(msg + "\n")
    git(repo, "add", "f.txt")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid",
        "commit", "-q", "-m", msg)
    return git(repo, "rev-parse", "HEAD")


class World:
    """An origin with main (A, B) and an unmerged branch (C, off A), and a
    server checkout of it sitting on A."""

    def __init__(self, tmp, bash):
        self.tmp, self.bash = tmp, bash
        work = os.path.join(tmp, "work")
        os.makedirs(work)
        git(work, "init", "-q", "-b", "main")
        self.a = commit(work, "A")
        self.b = commit(work, "B")
        git(work, "checkout", "-q", "-b", "side", self.a)
        self.c = commit(work, "C")
        self.origin = os.path.join(tmp, "origin.git")
        subprocess.run(["git", "clone", "-q", "--bare", work, self.origin], check=True)
        self.bench = os.path.join(tmp, "bench")
        subprocess.run(["git", "clone", "-q", self.origin, self.bench], check=True)
        git(self.bench, "checkout", "-q", "--detach", self.a)
        self.stubs = os.path.join(tmp, "stubs")
        os.makedirs(self.stubs)
        for name, body in STUBS.items():
            p = os.path.join(self.stubs, name)
            with open(p, "w") as fh:
                fh.write("#!/usr/bin/env bash\n" + body + "\n")
            os.chmod(p, 0o755)

    def deploy(self, sha, only_on=None):
        env = dict(os.environ, PATH=self.stubs + os.pathsep + os.environ["PATH"],
                   STUB_HOME=self.tmp, BENCH_DEPLOY_LOCK=os.path.join(self.tmp, "lock"))
        env.pop("BENCH_DEPLOY_ONLY_ON", None)
        if only_on:
            env["BENCH_DEPLOY_ONLY_ON"] = only_on
        r = subprocess.run([self.bash, SCRIPT, "1", self.bench,
                            os.path.join(self.tmp, "PACKAGES"), sha],
                           env=env, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr, git(self.bench, "rev-parse", "HEAD")


def pkg_world(tmp, bash, lock_line=None, health="printf 200"):
    """World plus a package `eng` with commits P1, P2 on its origin, its
    server checkout on P1, and a Bench commit D on main whose packages.lock
    names eng at P2 (or `lock_line`)."""
    w = World(tmp, bash)
    pwork = os.path.join(tmp, "pwork")
    os.makedirs(pwork)
    git(pwork, "init", "-q", "-b", "main")
    w.p1 = commit(pwork, "P1")
    w.p2 = commit(pwork, "P2")
    porigin = os.path.join(tmp, "porigin.git")
    subprocess.run(["git", "clone", "-q", "--bare", pwork, porigin], check=True)
    w.pkgs = os.path.join(tmp, "PACKAGES")
    w.eng = os.path.join(w.pkgs, "eng")
    os.makedirs(w.pkgs)
    subprocess.run(["git", "clone", "-q", porigin, w.eng], check=True)
    git(w.eng, "checkout", "-q", "--detach", w.p1)
    work = os.path.join(tmp, "work")
    git(work, "checkout", "-q", "main")
    with open(os.path.join(work, "packages.lock"), "w") as fh:
        fh.write("# comment\n\n" + (lock_line or "eng %s https://example.invalid/eng.git" % w.p2) + "\n")
    git(work, "add", "packages.lock")
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "D")
    w.d = git(work, "rev-parse", "HEAD")
    git(work, "push", "-q", w.origin, "main")
    with open(os.path.join(w.stubs, "curl"), "w") as fh:
        fh.write("#!/usr/bin/env bash\n" + health + "\n")
    return w


def run_deploy(w, *extra):
    env = dict(os.environ, PATH=w.stubs + os.pathsep + os.environ["PATH"],
               STUB_HOME=w.tmp, BENCH_DEPLOY_LOCK=os.path.join(w.tmp, "lock"),
               BENCH_DEPLOY_ONLY_ON="main")
    r = subprocess.run([w.bash, SCRIPT, "1", w.bench, w.pkgs, w.d, *extra],
                       env=env, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr, git(w.bench, "rev-parse", "HEAD"), git(w.eng, "rev-parse", "HEAD")


def test_packages_lock(bash):
    with tempfile.TemporaryDirectory() as tmp:
        w = pkg_world(tmp, bash)
        rc, out, head, eng = run_deploy(w)
        check("a package in packages.lock goes to its commit", (rc, head, eng), (0, w.d, w.p2))
    with tempfile.TemporaryDirectory() as tmp:
        w = pkg_world(tmp, bash)
        rc, out, head, eng = run_deploy(w, "eng=" + w.p1)
        check("a package named on the command line keeps its ref", (rc, eng), (0, w.p1))
    with tempfile.TemporaryDirectory() as tmp:
        w = pkg_world(tmp, bash, lock_line="eng main https://example.invalid/eng.git")
        rc, out, head, eng = run_deploy(w)
        check("a lock line without a full commit stops the deploy", (rc, head, eng), (1, w.a, w.p1))
        check("it says which", "eng needs a full commit id" in out, True)
    with tempfile.TemporaryDirectory() as tmp:
        w = pkg_world(tmp, bash, lock_line="eng " + "1" * 40 + " https://example.invalid/eng.git")
        rc, out, head, eng = run_deploy(w)
        check("a locked commit the origin lacks stops the deploy", (rc, head, eng), (1, w.a, w.p1))
    with tempfile.TemporaryDirectory() as tmp:
        w = pkg_world(tmp, bash, health="printf 500")
        rc, out, head, eng = run_deploy(w)
        check("a failed deploy rolls the package back too", (rc, head, eng), (1, w.a, w.p1))


def test_only_on_main(bash):
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, bash)
        rc, out, head = w.deploy(w.c, only_on="main")
        check("a commit only on an unmerged branch is refused", rc, 1)
        check("it says why", "is not on origin/main" in out, True)
        check("and the checkout stays where it was", head, w.a)

        rc, out, head = w.deploy(w.b, only_on="main")
        check("a commit on main is deployed", (rc, head), (0, w.b))

        rc, out, head = w.deploy(w.a, only_on="main")
        check("an earlier commit on main is deployed", (rc, head), (0, w.a))


def test_manual_route_unchanged(bash):
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, bash)
        rc, out, head = w.deploy(w.c)
        check("without BENCH_DEPLOY_ONLY_ON any fetched commit deploys", (rc, head), (0, w.c))


def main():
    bash = find_bash()
    if not bash:
        if os.environ.get("CI"):
            print("FAIL no bash 4 or later found; deploy-on-server.sh needs one")
            return 1
        print("skipped: no bash 4 or later found (set BENCH_TEST_BASH)")
        return 0
    test_only_on_main(bash)
    test_manual_route_unchanged(bash)
    test_packages_lock(bash)
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
