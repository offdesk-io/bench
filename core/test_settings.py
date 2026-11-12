#!/usr/bin/env python3
"""python3 core/test_settings.py"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import settings  # noqa: E402


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self._env = {k: os.environ.pop(k) for k in list(os.environ)
                     if k.startswith("BENCH_")}

    def tearDown(self):
        for k in [k for k in os.environ if k.startswith("BENCH_")]:
            del os.environ[k]
        os.environ.update(self._env)
        self.tmp.cleanup()

    def write(self, data):
        with open(os.path.join(self.root, "settings.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def test_missing_file_gives_defaults(self):
        self.assertEqual(settings.load(self.root), settings.DEFAULTS)
        self.assertIsNone(settings.model_for("brief", self.root))
        self.assertEqual(settings.model_for("brief", self.root, "x"), "x")

    def test_invalid_file_gives_defaults(self):
        with open(os.path.join(self.root, "settings.json"), "w", encoding="utf-8") as fh:
            fh.write("{nope")
        self.assertEqual(settings.load(self.root), settings.DEFAULTS)
        self.write(["list"])
        self.assertEqual(settings.load(self.root), settings.DEFAULTS)

    def test_env_overrides_file(self):
        self.write({"models": {"plan": "opus"}})
        os.environ["BENCH_MODEL_PLAN"] = "haiku"
        self.assertEqual(settings.model_for("plan", self.root), "haiku")

    def test_job_then_default_then_caller(self):
        self.write({"models": {"default": "sonnet", "chat": "opus"}})
        self.assertEqual(settings.model_for("chat", self.root), "opus")
        self.assertEqual(settings.model_for("plan", self.root), "sonnet")
        self.write({"models": {}})
        self.assertEqual(settings.model_for("plan", self.root, "haiku"), "haiku")

    def test_invalid_model_rejected_on_save(self):
        saved, err = settings.save(self.root, {"models": {"plan": "gpt"}})
        self.assertIsNone(saved)
        self.assertIn("one of", err)
        self.assertFalse(os.path.exists(os.path.join(self.root, "settings.json")))
        _, err = settings.save(self.root, {"models": {"nonsense": "opus"}})
        self.assertIn("unknown", err)

    def test_save_round_trip(self):
        saved, err = settings.save(self.root, {"models": {"default": "sonnet"}})
        self.assertIsNone(err)
        self.assertEqual(saved["models"]["default"], "sonnet")
        self.assertEqual(settings.load(self.root)["models"]["default"], "sonnet")

    def test_save_keeps_unknown_keys(self):
        self.write({"note": "mine", "machine": {"code_root": "~/A"},
                    "models": {"plan": "opus"}})
        settings.save(self.root, {"models": {"chat": "haiku"}})
        with open(os.path.join(self.root, "settings.json"), encoding="utf-8") as fh:
            got = json.load(fh)
        self.assertEqual(got["note"], "mine")
        self.assertEqual(got["machine"], {"code_root": "~/A"})
        self.assertEqual(got["models"]["chat"], "haiku")
        self.assertEqual(got["models"]["plan"], "opus")

    def test_agents_default_to_scheduled(self):
        self.assertEqual(settings.start_for("plan", self.root), "scheduled")
        self.assertEqual(settings.start_for("implement", self.root), "scheduled")
        self.write({"agents": {"plan": {"start": "bogus"}}})
        self.assertEqual(settings.start_for("plan", self.root), "scheduled")

    def test_agents_round_trip(self):
        saved, err = settings.save(self.root, {"agents": {"plan": {"start": "now"}}})
        self.assertIsNone(err)
        self.assertEqual(saved["agents"]["plan"]["start"], "now")
        self.assertEqual(saved["agents"]["implement"]["start"], "scheduled")
        self.assertEqual(settings.start_for("plan", self.root), "now")

    def test_agents_validated(self):
        for bad in ({"agents": []}, {"agents": {"nope": {}}},
                    {"agents": {"plan": "now"}}, {"agents": {"plan": {"start": "later"}}}):
            saved, err = settings.save(self.root, bad)
            self.assertIsNone(saved)
            self.assertTrue(err, bad)
        self.assertFalse(os.path.exists(os.path.join(self.root, "settings.json")))

    def test_save_keeps_unknown_agent_keys(self):
        self.write({"agents": {"plan": {"start": "now", "note": "mine"}, "other": {"x": 1}}})
        settings.save(self.root, {"models": {"chat": "haiku"}})
        with open(os.path.join(self.root, "settings.json"), encoding="utf-8") as fh:
            got = json.load(fh)
        self.assertEqual(got["agents"]["plan"], {"start": "now", "note": "mine"})
        self.assertEqual(got["agents"]["other"], {"x": 1})
        settings.save(self.root, {"agents": {"plan": {"start": "scheduled"}}})
        with open(os.path.join(self.root, "settings.json"), encoding="utf-8") as fh:
            got = json.load(fh)
        self.assertEqual(got["agents"]["plan"], {"start": "scheduled", "note": "mine"})

    def test_planner_follows_plan_unless_set(self):
        self.write({"models": {"plan": "opus"}})
        self.assertEqual(settings.planner_model(self.root), "opus")
        self.write({"models": {"plan": "opus", "planner": "haiku"}})
        self.assertEqual(settings.planner_model(self.root), "haiku")
        self.assertIsNone(settings.planner_model(self.root + "/none"))

    def fences(self, data=None):
        f = os.path.join(self.root, "agents", "fences.json")
        if data is not None:
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
        return f

    def read_fences(self):
        with open(self.fences(), encoding="utf-8") as fh:
            return json.load(fh)

    def test_budgets_missing_file_is_no_limit(self):
        self.assertEqual(settings.budgets(self.fences()),
                         {"daily_budget": None,
                          "agent_budgets": {"plan-agent": None, "implement-agent": None}})

    def test_budgets_per_agent_round_trip(self):
        f = self.fences({"other": 1, "agent_budgets": {"someone-else": 9}})
        err = settings.save_budgets(f, {"daily_budget": 10,
                                        "agent_budgets": {"plan-agent": 2, "implement-agent": 5.5}})
        self.assertIsNone(err)
        got = settings.budgets(f)
        self.assertEqual(got["daily_budget"], 10.0)
        self.assertEqual(got["agent_budgets"], {"plan-agent": 2.0, "implement-agent": 5.5})
        self.assertEqual(self.read_fences()["other"], 1)
        self.assertEqual(self.read_fences()["agent_budgets"]["someone-else"], 9)

    def test_budgets_cleared_by_empty(self):
        f = self.fences({"daily_budget": 3, "agent_budgets": {"plan-agent": 2}, "other": 1})
        settings.save_budgets(f, {"daily_budget": "", "agent_budgets": {"plan-agent": None}})
        self.assertEqual(self.read_fences(), {"other": 1})
        settings.save_budgets(f, {"agent_budgets": {"implement-agent": 4}})
        self.assertEqual(self.read_fences(), {"other": 1, "agent_budgets": {"implement-agent": 4.0}})

    def test_budgets_untouched_when_not_sent(self):
        f = self.fences({"daily_budget": 3, "agent_budgets": {"plan-agent": 2}})
        settings.save_budgets(f, {"models": {"chat": "haiku"}})
        settings.save_budgets(f, {"agent_budgets": {"implement-agent": 1}})
        self.assertEqual(self.read_fences(), {"daily_budget": 3,
                                              "agent_budgets": {"plan-agent": 2, "implement-agent": 1.0}})

    def test_budgets_validated(self):
        f = self.fences({"daily_budget": 3})
        for bad in ({"daily_budget": "lots"}, {"daily_budget": -1}, {"daily_budget": True},
                    {"agent_budgets": []}, {"agent_budgets": {"nobody": 1}},
                    {"agent_budgets": {"plan-agent": "2"}}, {"agent_budgets": {"plan-agent": -2}}):
            self.assertTrue(settings.save_budgets(f, bad), bad)
        self.assertEqual(self.read_fences(), {"daily_budget": 3})

    def test_settings_hold_models_agents_and_chime_only(self):
        self.assertEqual(sorted(settings.DEFAULTS), ["agents", "chime", "models", "version"])
        self.write({"machine": {"code_root": "~/Elsewhere"}})
        self.assertNotIn("machine", settings.load(self.root))

    # ---- memory_root ----------------------------------------------------

    def memory(self):
        path = os.path.join(self.root, "MEMORY")
        os.makedirs(path, exist_ok=True)
        return path

    def test_chime_on_by_default_and_saved(self):
        self.assertIs(settings.load(self.root)["chime"], True)
        saved, err = settings.save(self.root, {"chime": False})
        self.assertIsNone(err)
        self.assertIs(saved["chime"], False)
        self.assertIs(settings.load(self.root)["chime"], False)
        saved, _ = settings.save(self.root, {"models": {"plan": "opus"}})
        self.assertIs(saved["chime"], False)
        saved, _ = settings.save(self.root, {"chime": True})
        self.assertIs(saved["chime"], True)

    def test_chime_must_be_true_or_false(self):
        for bad in ("yes", 1, None):
            self.assertIn("chime", settings.validate({"chime": bad}, self.root))
        self.assertIsNone(settings.validate({"chime": False}, self.root))

    def test_memory_root_unset_is_absent(self):
        self.write({"models": {"plan": "opus"}})
        self.assertNotIn("memory_root", settings.load(self.root))
        self.assertIsNone(settings.memory_root(self.root))
        self.write({"memory_root": "   "})
        self.assertIsNone(settings.memory_root(self.root))

    def test_memory_root_read_and_must_exist(self):
        mem = self.memory()
        self.write({"memory_root": mem})
        self.assertEqual(settings.load(self.root)["memory_root"], mem)
        self.assertEqual(settings.memory_root(self.root), mem)
        self.write({"memory_root": os.path.join(self.root, "gone")})
        self.assertIsNone(settings.memory_root(self.root))

    def test_memory_root_validated(self):
        mem = self.memory()
        self.assertIsNone(settings.validate({"memory_root": mem}))
        self.assertIsNone(settings.validate({"memory_root": ""}))
        self.assertIsNone(settings.validate({"memory_root": None}))
        self.assertIn("folder path", settings.validate({"memory_root": 3}))
        self.assertIn("full path", settings.validate({"memory_root": "MEMORY"}))
        self.assertIn("no folder", settings.validate({"memory_root": os.path.join(self.root, "gone")}))

    def test_memory_root_save_keep_and_clear(self):
        mem = self.memory()
        saved, err = settings.save(self.root, {"memory_root": mem})
        self.assertIsNone(err)
        self.assertEqual(saved["memory_root"], mem)
        settings.save(self.root, {"models": {"plan": "opus"}})
        self.assertEqual(settings.load(self.root)["memory_root"], mem)
        saved, _ = settings.save(self.root, {"memory_root": ""})
        self.assertNotIn("memory_root", saved)
        with open(os.path.join(self.root, "settings.json")) as fh:
            self.assertNotIn("memory_root", json.load(fh))

    def board(self, name):
        os.makedirs(os.path.join(self.root, name), exist_ok=True)
        open(os.path.join(self.root, name, "todo.md"), "w").close()

    def test_memory_file_unset_is_beside_the_list(self):
        self.board("work")
        for name in settings.MEMORY_FILES:
            here = os.path.join(self.root, "work", name + ".md")
            self.assertEqual(settings.memory_file("work", name, self.root), here)
            self.assertEqual(settings.memory_file("work", name, self.root, write=True), here)
        self.assertEqual(settings.people_path("work", self.root),
                         os.path.join(self.root, "work", "people.md"))

    def test_memory_file_set_reads_the_memory_copy(self):
        self.board("work")
        mem = self.memory()
        self.write({"memory_root": mem})
        there = os.path.join(mem, "bench", "work", "about.md")
        os.makedirs(os.path.dirname(there))
        open(there, "w").close()
        open(os.path.join(self.root, "work", "about.md"), "w").close()
        self.assertEqual(settings.memory_file("work", "about", self.root), there)

    def test_memory_file_set_falls_back_to_the_list(self):
        self.board("work")
        mem = self.memory()
        self.write({"memory_root": mem})
        for name in settings.MEMORY_FILES:
            self.assertEqual(settings.memory_file("work", name, self.root),
                             os.path.join(self.root, "work", name + ".md"))
        self.assertFalse(os.path.exists(os.path.join(mem, "bench")))

    def test_memory_file_write_goes_to_the_memory_folder(self):
        self.board("work")
        mem = self.memory()
        self.write({"memory_root": mem})
        open(os.path.join(self.root, "work", "context.md"), "w").close()
        there = os.path.join(mem, "bench", "work", "context.md")
        self.assertEqual(settings.memory_file("work", "context", self.root, write=True), there)
        self.assertTrue(os.path.isdir(os.path.dirname(there)))
        self.assertEqual(settings.people_path("work", self.root, write=True),
                         os.path.join(mem, "bench", "work", "people.md"))
        # A memory folder that has gone counts as unset.
        self.write({"memory_root": os.path.join(self.root, "gone")})
        self.assertEqual(settings.memory_file("work", "context", self.root, write=True),
                         os.path.join(self.root, "work", "context.md"))

    def test_memory_file_refuses_what_is_not_a_list(self):
        self.board("work")
        os.makedirs(os.path.join(self.root, "notalist"))
        mem = self.memory()
        self.write({"memory_root": mem})
        for bad in ("", None, 3, "..", ".", "../work", "work/..", "work/../work",
                    "/etc", ".current", "notalist", "gone", "WORK", "work\0"):
            for write in (False, True):
                with self.assertRaises(ValueError, msg=repr(bad)):
                    settings.memory_file(bad, "people", self.root, write)
        for bad in ("profile", "todo", "../people", None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                settings.memory_file("work", bad, self.root)
        self.assertFalse(os.path.exists(os.path.join(mem, "bench")))

    def test_boards_md_lists_and_marks(self):
        text = settings.boards_md(["work", "home"], "work", "/C/bench/data", "/C/MEMORY")
        self.assertTrue(text.startswith(settings.BOARDS_HEADER))
        self.assertIn("Only PA changes boards", text)
        self.assertEqual(text.split("\n\n", 2)[2].splitlines(), [
            "- home: `bench/data/home/`",
            "- work (current): `bench/data/work/`"])
        # A memory folder that is not beside the repo gets full paths.
        self.assertIn("- home: `/C/bench/data/home/`",
                      settings.boards_md(["home"], None, "/C/bench/data", "/Elsewhere/MEMORY"))

    def test_boards_md_carries_marks_and_descriptions(self):
        previous = (
            "# Boards\n\nWritten by hand.\n\n"
            "- work (current): `bench/data/work/`, the live list\n"
            "- old (frozen, never write): `bench/data/old/`, kept for posterity\n"
            "- gone: `bench/data/gone/`, removed since\n")
        text = settings.boards_md(["work", "old", "home", "new"], "home",
                                  "/C/bench/data", "/C/MEMORY", previous)
        self.assertEqual(text.split("\n\n", 2)[2].splitlines(), [
            "- work: `bench/data/work/`, the live list",
            "- old (frozen, never write): `bench/data/old/`, kept for posterity",
            "- home (current): `bench/data/home/`",
            "- new: `bench/data/new/`"])
        self.assertNotIn("Written by hand", text)

    def test_write_boards_only_with_a_memory_folder(self):
        data = os.path.join(self.root, "data")
        os.makedirs(data)
        self.assertIsNone(settings.write_boards(["work"], "work", data))
        mem = self.memory()
        with open(os.path.join(data, "settings.json"), "w") as fh:
            json.dump({"memory_root": mem}, fh)
        target = settings.write_boards(["work", "home"], "work", data)
        self.assertEqual(target, os.path.join(mem, "boards.md"))
        with open(target) as fh:
            self.assertIn("- work (current): `data/work/`", fh.read())
        self.assertEqual(sorted(os.listdir(mem)), ["boards.md"])
        settings.write_boards(["home"], "home", data)
        with open(target) as fh:
            got = fh.read()
        self.assertIn("- home (current)", got)
        self.assertNotIn("work", got.split("\n\n", 2)[2])

    # ---- projects_roots -------------------------------------------------

    def projects(self, name="PROJECTS"):
        path = os.path.join(self.root, name)
        os.makedirs(path, exist_ok=True)
        return path

    def lists(self, *names):
        for n in names:
            os.makedirs(os.path.join(self.root, n), exist_ok=True)
            open(os.path.join(self.root, n, "todo.md"), "w").close()

    def test_projects_roots_unset_is_absent(self):
        self.write({"models": {"plan": "opus"}})
        self.assertNotIn("projects_roots", settings.load(self.root))
        self.assertIsNone(settings.projects_root("work", self.root))
        self.write({"projects_roots": {"work": "  "}})
        self.assertNotIn("projects_roots", settings.load(self.root))
        self.write({"projects_roots": "nope"})
        self.assertIsNone(settings.projects_root("work", self.root))

    def test_projects_root_is_per_list_and_must_exist(self):
        proj = self.projects()
        self.write({"projects_roots": {"work": proj}})
        self.assertEqual(settings.load(self.root)["projects_roots"], {"work": proj})
        self.assertEqual(settings.projects_root("work", self.root), proj)
        self.assertIsNone(settings.projects_root("home", self.root))
        self.write({"projects_roots": {"work": os.path.join(self.root, "gone")}})
        self.assertIsNone(settings.projects_root("work", self.root))

    def test_projects_roots_validated(self):
        self.lists("work", "home")
        proj, other = self.projects(), self.projects("OTHER")
        ok = lambda d: settings.validate({"projects_roots": d}, self.root)
        self.assertIsNone(ok({"work": proj}))
        self.assertIsNone(ok({"work": proj, "home": other}))
        self.assertIsNone(ok({"work": "", "gone": None}))
        self.assertIn("object", ok(["work"]))
        self.assertIn("no list called nobody", ok({"nobody": proj}))
        self.assertIn("folder path", ok({"work": 3}))
        self.assertIn("full path", ok({"work": "PROJECTS"}))
        self.assertIn("no folder", ok({"work": os.path.join(self.root, "gone")}))
        self.assertIn("cannot share", ok({"work": proj, "home": proj}))
        self.assertIn("cannot share", ok({"work": proj, "home": proj + "/"}))
        # A clash with a list already on disk counts too, and moving it off clears it.
        self.write({"projects_roots": {"work": proj}})
        self.assertIn("cannot share", ok({"home": proj}))
        self.assertIsNone(ok({"home": proj, "work": None}))

    def test_projects_roots_same_folder_by_another_spelling(self):
        self.lists("work", "home")
        proj = self.projects("Proj")
        other = os.path.join(self.root, "proj")
        if not os.path.isdir(other):
            self.skipTest("the test volume is case-sensitive")
        ok = lambda d: settings.validate({"projects_roots": d}, self.root)
        self.assertIn("cannot share", ok({"work": proj, "home": other}))
        self.write({"projects_roots": {"work": proj}})
        self.assertIn("cannot share", ok({"home": other}))

    def test_projects_roots_same_folder_through_a_symlink(self):
        self.lists("work", "home")
        proj = self.projects()
        link = os.path.join(self.root, "link")
        os.symlink(proj, link)
        self.write({"projects_roots": {"work": proj}})
        self.assertIn("cannot share",
                      settings.validate({"projects_roots": {"home": link}}, self.root))

    def test_projects_roots_save_per_list(self):
        self.lists("work", "home")
        proj, other = self.projects(), self.projects("OTHER")
        saved, err = settings.save(self.root, {"projects_roots": {"work": proj}})
        self.assertIsNone(err)
        self.assertEqual(saved["projects_roots"], {"work": proj})
        settings.save(self.root, {"projects_roots": {"home": other}})
        settings.save(self.root, {"models": {"plan": "opus"}})
        self.assertEqual(settings.load(self.root)["projects_roots"], {"work": proj, "home": other})
        saved, err = settings.save(self.root, {"projects_roots": {"home": proj}})
        self.assertIn("cannot share", err)
        saved, _ = settings.save(self.root, {"projects_roots": {"work": None}})
        self.assertEqual(saved["projects_roots"], {"home": other})
        saved, _ = settings.save(self.root, {"projects_roots": {"home": ""}})
        self.assertNotIn("projects_roots", saved)
        with open(os.path.join(self.root, "settings.json")) as fh:
            self.assertNotIn("projects_roots", json.load(fh))

    def test_project_homes_follow_the_list(self):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import project_folders
        work = os.path.join(self.root, "work")
        own = os.path.join(work, "projects")
        self.assertEqual(project_folders.homes(work), [own])
        self.assertEqual(project_folders.locate("idea", work), os.path.join(own, "idea"))
        proj = self.projects()
        self.write({"projects_roots": {"work": proj}})
        self.assertEqual(project_folders.homes(work), [proj, own])
        self.assertEqual(project_folders.home(work), proj)
        self.assertEqual(project_folders.locate("idea", work), os.path.join(proj, "idea"))
        os.makedirs(os.path.join(own, "idea"))
        self.assertEqual(project_folders.locate("idea", work), os.path.join(own, "idea"))
        os.makedirs(os.path.join(proj, "idea"))
        self.assertEqual(project_folders.locate("idea", work), os.path.join(proj, "idea"))
        home = os.path.join(self.root, "home")
        self.assertEqual(project_folders.homes(home), [os.path.join(home, "projects")])
    def test_for_boards_names_only_those_boards(self):
        a, b = self.projects(), os.path.join(self.root, "b")
        os.makedirs(b)
        self.write({"projects_roots": {"work": a, "secret": b}, "memory_root": self.root})
        saved = settings.load(self.root)
        self.assertEqual(settings.for_boards(saved, ["work"])["projects_roots"], {"work": "PROJECTS"})
        self.assertNotIn("memory_root", settings.for_boards(saved, ["work"]))
        self.assertNotIn("projects_roots", settings.for_boards(saved, []))
        self.assertIn("secret", saved["projects_roots"])


class ProfileTest(unittest.TestCase):
    """A signed-in person's own profile, beside their user record, and the
    shared data/profile.md as everybody's fallback."""

    TIAGO, JEROME = "tiago@example.com", "Jerome@Example.com"

    def setUp(self):
        import board_access
        import owner_profile
        self.ba, self.op = board_access, owner_profile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self._env = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("BENCH_")}
        self.shared = os.path.join(self.root, "profile.md")
        with open(self.shared, "w", encoding="utf-8") as fh:
            fh.write("# PA profile\n\n## About\n\n- Name: Tiago/Jerome\n- Country: GB\n- Region: GB-SCT\n\n"
                     "## Writing\n\n- Spelling: British English\n")

    def tearDown(self):
        for k in [k for k in os.environ if k.startswith("BENCH_")]:
            del os.environ[k]
        os.environ.update(self._env)
        self.tmp.cleanup()

    def text(self, path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def test_own_file_sits_beside_the_user_record(self):
        own = self.op.own_profile_path(self.JEROME, self.root)
        record = self.ba.user_path(self.root, self.JEROME)
        self.assertEqual(os.path.dirname(own), os.path.dirname(record))
        self.assertEqual(os.path.basename(own), os.path.basename(record)[:-5] + ".profile.md")
        self.assertEqual(own, self.op.own_profile_path("jerome@example.com", self.root))

    def test_nobody_saved_reads_the_shared_profile(self):
        self.assertEqual(self.op.profile_path(self.root, self.JEROME), self.shared)
        self.assertEqual(self.op.owner_name(self.root, self.JEROME), "Tiago/Jerome")
        self.assertEqual(self.op.holiday_place(self.root, self.JEROME), ("GB", "GB-SCT"))

    def test_a_write_lands_in_the_persons_file_only(self):
        before = self.text(self.shared)
        self.assertIsNone(self.op.write_basics(self.root, "Jerome", country="PT", region="",
                                               address=self.JEROME))
        own = self.op.own_profile_path(self.JEROME, self.root)
        self.assertEqual(self.text(self.shared), before)
        self.assertTrue(os.path.isfile(own))
        self.assertEqual(self.op.profile_path(self.root, self.JEROME), own)
        self.assertEqual(self.op.owner_name(self.root, self.JEROME), "Jerome")
        self.assertEqual(self.op.holiday_regions(self.root, self.JEROME), ("PT:",))
        # Anybody else, and the Mac with no address, still read the shared one.
        self.assertEqual(self.op.owner_name(self.root, self.TIAGO), "Tiago/Jerome")
        self.assertEqual(self.op.owner_name(self.root), "Tiago/Jerome")
        self.assertEqual(self.op.holiday_place(self.root), ("GB", "GB-SCT"))

    def test_a_first_write_keeps_what_the_person_was_reading(self):
        self.op.write_basics(self.root, "Jerome", address=self.JEROME)
        self.assertEqual(self.op.holiday_place(self.root, self.JEROME), ("GB", "GB-SCT"))
        self.assertIn("- Spelling: British English", self.text(self.op.own_profile_path(self.JEROME, self.root)))

    def test_a_person_with_no_shared_profile_starts_from_the_template(self):
        os.remove(self.shared)
        self.op.write_basics(self.root, "Jerome", address=self.JEROME)
        text = self.text(self.op.own_profile_path(self.JEROME, self.root))
        self.assertIn("## Working habits", text)
        self.assertFalse(os.path.exists(self.shared))

    def test_own_profile_is_not_a_board_person(self):
        self.op.write_basics(self.root, "Jerome", address=self.JEROME)
        access = {"owner": "tiago@example.com", "people": [], "teams": ["offdesk"]}
        self.assertEqual([p["email"] for p in self.ba.board_people(self.root, access)], ["tiago@example.com"])

    def test_about_and_sections_round_trip(self):
        err = self.op.write_basics(self.root, about={"addressing": "Hey Jerome", "facts_file": ""},
                                   sections={"writing": "- Spelling: French\n- Rules: short",
                                             "habits": "- Deferring: logs ideas first"},
                                   address=self.JEROME)
        self.assertIsNone(err)
        self.assertEqual(self.op.about_fields(self.root, self.JEROME),
                         {"addressing": "Hey Jerome", "facts_file": ""})
        got = self.op.section_texts(self.root, self.JEROME)
        self.assertEqual(got["writing"], "- Spelling: French\n- Rules: short")
        self.assertEqual(got["habits"], "- Deferring: logs ideas first")
        self.assertEqual(got["recorder"], "")
        prof = self.op.read(self.root, self.JEROME)
        self.assertEqual(prof["spelling"], "French")
        self.assertEqual(prof["how to address them"], "Hey Jerome")
        self.assertEqual(prof["name"], "Tiago/Jerome")
        # The shared file is as it was.
        self.assertEqual(self.op.section_texts(self.root)["writing"], "- Spelling: British English")

    def test_an_empty_section_puts_the_template_back(self):
        self.op.write_basics(self.root, sections={"writing": ""}, address=self.JEROME)
        own = self.text(self.op.own_profile_path(self.JEROME, self.root))
        self.assertIn("- Spelling: <e.g. British English>", own)
        self.assertEqual(self.op.section_texts(self.root, self.JEROME)["writing"], "")
        self.assertNotIn("spelling", self.op.read(self.root, self.JEROME))
        self.assertTrue(own.endswith("\n"))

    def test_the_template_reads_as_empty_boxes(self):
        os.remove(self.shared)
        self.assertEqual(self.op.section_texts(self.root),
                         {"setup": "", "writing": "", "recorder": "", "habits": ""})
        self.assertIn("<e.g. British English>", self.op.section_hints()["writing"])

    def test_bad_fields_are_refused_and_nothing_is_written(self):
        for about, sections in (({"addressing": "two\nlines"}, {}), ({"addressing": "<x>"}, {}),
                                ({"nope": "x"}, {}), ({}, {"writing": "## About\n- Name: X"}),
                                ({}, {"nope": "x"}), ({}, {"habits": "x" * 4001})):
            self.assertIsNotNone(self.op.write_basics(self.root, about=about, sections=sections,
                                                      address=self.JEROME), (about, sections))
        self.assertFalse(os.path.exists(self.op.own_profile_path(self.JEROME, self.root)))

    def test_a_shared_boards_calendar_is_its_owners(self):
        board = os.path.join(self.root, "offdesk")
        os.makedirs(board)
        self.ba.write(board, {"owner": "jerome@example.com", "people": [], "teams": []})
        self.op.write_basics(self.root, country="PT", region="", address=self.JEROME)
        # Off, there is nobody signed in and the shared profile decides.
        self.assertEqual(self.op.board_holiday_regions(board, self.root), ("GB:GB-SCT",))
        os.environ["BENCH_AUTH"] = "header"
        self.assertEqual(self.op.calendar_address(board), "jerome@example.com")
        self.assertEqual(self.op.board_holiday_regions(board, self.root), ("PT:",))
        # A board nobody owns falls back to the shared profile.
        self.assertEqual(self.op.board_holiday_regions(os.path.join(self.root, "none"), self.root),
                         ("GB:GB-SCT",))


if __name__ == "__main__":
    unittest.main()
