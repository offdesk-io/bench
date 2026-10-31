"""Run: python3 core/test_bench_root.py"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_root  # noqa: E402

CHECKOUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class BenchRootTest(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in ("BENCH_ROOT", "BENCH_PACKAGES")}

    def tearDown(self):
        for k, v in self._saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def test_defaults(self):
        self.assertEqual(bench_root.root(), CHECKOUT)
        self.assertEqual(bench_root.packages(),
                         os.path.normpath(os.path.join(CHECKOUT, "..", "PACKAGES")))

    def test_root_env(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["BENCH_ROOT"] = d
            self.assertEqual(bench_root.root(), d)
            self.assertEqual(bench_root.packages(),
                             os.path.normpath(os.path.join(d, "..", "PACKAGES")))

    def test_packages_env(self):
        os.environ["BENCH_PACKAGES"] = "/somewhere/pkgs"
        self.assertEqual(bench_root.packages(), "/somewhere/pkgs")
        self.assertEqual(bench_root.root(), CHECKOUT)

    def test_empty_env_falls_back(self):
        os.environ["BENCH_ROOT"] = ""
        os.environ["BENCH_PACKAGES"] = ""
        self.assertEqual(bench_root.root(), CHECKOUT)


if __name__ == "__main__":
    unittest.main()
