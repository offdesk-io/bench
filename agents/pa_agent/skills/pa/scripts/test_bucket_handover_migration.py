#!/usr/bin/env python3
"""python3 test_bucket_handover_migration.py

Over a throwaway data root only: no real list is read or written."""

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bucket_handover_migration as mig  # noqa: E402
import bucket_agents  # noqa: E402

FILLED = {
    "What this agent is for": "Does the work.",
    "The processes I run in this bucket": "**Weekly.** Produces a file.",
    "Guidelines it follows": "Keep it short.",
    "What it may touch": "`out/`.",
    "What it must never touch": "Anything else.",
    "What good looks like here": "One edit at most.",
}

TODO = """# To-do

## 1. Plan First

### Doing

- [ ] **Alpha** `id:aaaaaa` [to:: Plan agent]
  - [ ] Plan [to:: Plan agent] `#aaaaaa-plan` `id:a00001`
  - [ ] Review the plan [to:: Tiago] `#aaaaaa-plan-review` `blocked-by:aaaaaa-plan` `id:a00002`
  - [ ] Implement [to:: Implement agent] `#aaaaaa-implement` `blocked-by:aaaaaa-plan-review` `id:a00003`
  - [ ] Review the work [to:: Tiago] `#aaaaaa-work-review` `blocked-by:aaaaaa-implement` `id:a00004`

## 2. Free Rein

### Doing

- [ ] **Bravo** `id:bbbbbb` [to:: Plan agent]
  - [ ] Plan [to:: Plan agent] `#bbbbbb-plan` `id:b00001`
  - [ ] Review the plan [to:: Tiago] `#bbbbbb-plan-review` `blocked-by:bbbbbb-plan` `id:b00002`
  - [ ] Implement [to:: Implement agent] `#bbbbbb-implement` `blocked-by:bbbbbb-plan-review` `id:b00003`
- [ ] **Bravo two** `id:bbbb22` [to:: Plan agent]
  - [x] Plan [to:: Plan agent] `#bbbb22-plan` `id:b00011`
  - [ ] Review the plan [to:: Tiago] `#bbbb22-plan-review` `id:b00012`
  - [ ] Implement [to:: Implement agent] `#bbbb22-implement` `id:b00013`

## 3. Not Ready

### Doing

- [ ] **Charlie** `id:cccccc` [to:: Implement agent]
  - [ ] Implement [to:: Implement agent] `#cccccc-implement` `id:c00001`

## 4. Nowhere

### Doing

- [ ] **Delta** `id:dddddd` [to:: Implement agent]
  - [ ] Implement [to:: Implement agent] `#dddddd-implement` `id:d00001`
- [ ] **Echo** `id:eeeeee` [to:: Someone]
  - [ ] Step [to:: Someone] `id:e00001`
"""


def brief(mode):
    with open(bucket_agents.TEMPLATE, encoding="utf-8") as fh:
        text = fh.read()
    text = "---\nmode: %s\n---\n" % mode + text.split("---\n", 2)[2]
    text = text.replace(bucket_agents.NOT_FILLED + "\n", "")
    for heading, body in FILLED.items():
        text = text.replace("## %s\n\n" % heading, "## %s\n\n%s\n\n" % (heading, body))
    return text


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        base = os.path.join(self.root, "demo")
        os.makedirs(base)
        self.todo = os.path.join(base, "todo.md")
        with open(self.todo, "w", encoding="utf-8") as fh:
            fh.write(TODO)
        for name, text in (("plan-first", brief("plan-first")), ("free-rein", brief("free-rein")),
                           ("not-ready", None)):
            folder = os.path.join(base, "buckets", name)
            os.makedirs(folder)
            with open(os.path.join(folder, name + ".md"), "w", encoding="utf-8") as fh:
                with open(bucket_agents.TEMPLATE, encoding="utf-8") as t:
                    fh.write(text if text else t.read())
        self.items = {i["id"]: i for i in mig.migrate("demo", self.root)}

    def tearDown(self):
        self.tmp.cleanup()

    def test_plan_first_moves_plan_and_implement_and_keeps_reviews(self):
        it = self.items["aaaaaa"]
        self.assertEqual(it["status"], "move")
        self.assertEqual(it["agent"], "Demo plan-first agent")
        news = [n for _, n in it["changes"]]
        self.assertEqual(len(news), 3)
        self.assertTrue(all("[to:: Demo plan-first agent]" in n for n in news))
        self.assertFalse(any("Tiago" in o and "Tiago" not in n for o, n in it["changes"]))

    def test_free_rein_drops_an_open_plan_pair(self):
        it = self.items["bbbbbb"]
        drops = [o for o, n in it["changes"] if n is None]
        self.assertEqual(len(drops), 2)
        self.assertTrue(any("bbbbbb-plan`" in o for o in drops))
        self.assertTrue(any("bbbbbb-plan-review" in o for o in drops))
        moved = [n for _, n in it["changes"] if n]
        self.assertTrue(any("bbbbbb-implement" in n and "Demo free-rein agent" in n for n in moved))

    def test_free_rein_keeps_a_plan_that_is_ticked(self):
        it = self.items["bbbb22"]
        self.assertEqual([o for o, n in it["changes"] if n is None], [])

    def test_not_ready_bucket_is_flagged_and_unchanged(self):
        it = self.items["cccccc"]
        self.assertEqual(it["status"], "skip")
        self.assertEqual(it["changes"], [])
        self.assertIn("pa-bucket-setup", it["reason"])

    def test_task_with_no_bucket_is_flagged(self):
        it = self.items["dddddd"]
        self.assertEqual(it["status"], "skip")
        self.assertIn("no bucket", it["reason"])

    def test_people_tasks_are_left_out(self):
        self.assertNotIn("eeeeee", self.items)

    def test_it_never_writes(self):
        with open(self.todo, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), TODO)
        self.assertIn("Nothing was written", mig.render(list(self.items.values()), "demo"))


if __name__ == "__main__":
    unittest.main()
