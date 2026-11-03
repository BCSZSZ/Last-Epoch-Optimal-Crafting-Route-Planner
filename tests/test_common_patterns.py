"""Regress the user's identity-sensitive 771x and 7732 crafting examples."""
from fractions import Fraction
from itertools import permutations
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from check_7710_routes import DISPLAY, Evaluator, load_cases
from check_common_patterns import create_cases


class CommonPatternTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = create_cases()
        _, cls.definitions = load_cases()

    def evaluator(self, case):
        return Evaluator(case, case["routes"][0], "NORMAL", DISPLAY, self.definitions)

    @staticmethod
    def state(case):
        return tuple((row["id"], row["tier"], row["sealed"]) for row in case["initialAffixes"])

    def tearDown(self):
        Evaluator.evaluate.cache_clear()
        Evaluator.action.cache_clear()
        Evaluator.fp_kernel.cache_clear()
        Evaluator.critical_kernel.cache_clear()

    def test_existing_a_is_not_added_again(self):
        for case in self.payload["cases"]:
            with self.subTest(case=case["id"]):
                self.assertNotIn("ADD_A", case["routes"][0]["steps"])
                self.assertEqual(self.evaluator(case).can_add(self.state(case), 4), "DUPLICATE_ID")

    def test_target_a_at_t1_cannot_be_used_as_the_garbage_seal(self):
        case = next(row for row in self.payload["cases"] if row["id"] == "existing_a_prepare_x3")
        evaluator = self.evaluator(case)
        moved = ((4, 1, False), (26, 7, False), (10, 7, False), (7, 3, False))
        self.assertEqual(evaluator.junk(moved, only_t1=True), [])
        self.assertEqual(evaluator.action("SEAL_CURRENT_JUNK", moved, 63), ())

    def test_preparation_can_keep_target_identity_while_moving_its_tier(self):
        case = next(row for row in self.payload["cases"] if row["id"] == "existing_a_prepare_x1")
        evaluator = self.evaluator(case)
        prepared = ((4, 1, False), (26, 1, False), (10, 7, False), (7, 7, False))
        self.assertEqual(evaluator.junk(prepared, only_t1=True), [1])
        self.assertEqual(evaluator.seal_probability(prepared, 1), 1)

    def test_direct_t1_seal_is_certain_for_every_declared_x(self):
        for case in self.payload["cases"]:
            if case["patternFamily"] != "existing_a_direct":
                continue
            with self.subTest(x=case["x"]):
                evaluator = self.evaluator(case)
                state = self.state(case)
                self.assertEqual(evaluator.junk(state, only_t1=True), [2])
                self.assertEqual(evaluator.seal_probability(state, 2), 1)
                exits = evaluator.action("SEAL_CURRENT_JUNK", state, 63)
                self.assertTrue(all(not abort and new[0] == (2, 1, True) for new, _, abort, _ in exits))

    def test_repeated_tiers_and_three_t7_use_the_correct_preparation_layout_counts(self):
        for x, layout_count, goal_count, hit in ((1, 6, 3, Fraction(3, 5)),
                                                 (3, 12, 3, Fraction(3, 11)),
                                                 (7, 4, 1, Fraction(1, 3))):
            case = next(row for row in self.payload["cases"] if row["id"] == f"existing_a_prepare_x{x}")
            evaluator = self.evaluator(case)
            initial = self.state(case)
            layouts = {tuple((row[0], tier, False) for row, tier in zip(initial, tiers))
                       for tiers in permutations(row[1] for row in initial)}
            goals = [state for state in layouts if evaluator.junk(state, only_t1=True)]
            with self.subTest(x=x):
                self.assertFalse(evaluator.junk(initial, only_t1=True))
                self.assertEqual((len(layouts), len(goals)), (layout_count, goal_count))
                self.assertEqual(Fraction(len(goals), len(layouts) - 1), hit)

    def test_x7_preserves_three_t7_through_seal_and_add(self):
        case = next(row for row in self.payload["cases"] if row["id"] == "existing_a_direct_x7")
        evaluator = self.evaluator(case)
        self.assertEqual(evaluator.initial_t7_count, 3)
        sealed, _, aborted, _ = evaluator.action("SEAL_CURRENT_JUNK", self.state(case), 63)[0]
        self.assertFalse(aborted)
        for state, _, _, _ in evaluator.action("ADD_B", sealed, 63):
            self.assertEqual(sum(tier == 7 and not seal for _, tier, seal in state), 3)
            self.assertIn((4, 7, False), state)

    def test_x0_recipe_fails_without_a_fourth_ordinary_affix(self):
        case = self.payload["negativeCases"][0]
        evaluator = self.evaluator(case)
        result = evaluator.evaluate(0, self.state(case), 63)
        self.assertEqual(result.p.hi, 0)
        self.assertTrue(case["notGloballyImpossible"])

    def test_x0_with_a_compatible_empty_side_can_add_b_and_havoc(self):
        case = {"targetAId": 4, "targetBId": 5,
                "initialAffixes": [{"id": identity, "tier": tier, "sealed": False}
                                   for identity, tier in ((4, 7), (7, 7), (10, 1))],
                "routes": [{"steps": ["ADD_B", "FINAL_HAVOC"]}]}
        evaluator = self.evaluator(case)
        self.assertIsNone(evaluator.can_add(self.state(case), 5))
        self.assertGreater(evaluator.evaluate(0, self.state(case), 30).p.lo, 0)

    def test_7732_with_both_target_identities_matches_the_independent_havoc_reference(self):
        case = {"targetAId": 4, "targetBId": 5,
                "initialAffixes": [{"id": identity, "tier": tier, "sealed": False}
                                   for identity, tier in ((7, 7), (10, 7), (4, 3), (5, 2))],
                "routes": [{"steps": ["FINAL_HAVOC"]}]}
        evaluator = self.evaluator(case)
        artifact = json.loads((ROOT / "research/fp-examples.json").read_text(encoding="utf-8"))
        curves = next(row for row in artifact["profiles"] if row["id"] == DISPLAY)["fixedFamilyHavocReferenceCurves"]
        curve = next(row for row in curves if row["tierFamily"] == "77tu" and row["fpType"] == "NORMAL" and row["glyphOfHope"])
        for fp in (0, 1, 30, 63):
            with self.subTest(fp=fp):
                result = evaluator.evaluate(0, self.state(case), fp)
                expected = curve["rows"][fp]
                self.assertAlmostEqual((result.p.lo + result.p.hi) / 2, expected["successProbability"], places=12)
                self.assertAlmostEqual((result.spent.lo + result.spent.hi) / 2, expected["expectedActualFpSpent"], places=11)

    def test_pattern_priority_is_not_an_impossibility_whitelist(self):
        model = json.loads((ROOT / "research/model-snapshot.json").read_text(encoding="utf-8"))
        policy = model["policies"]
        self.assertTrue(policy["commonPatternsPrioritizedNotExclusive"])
        self.assertEqual(policy["unassessedPatternStatus"], "UNASSESSED")
        self.assertIn("ALL_TARGETS_ABSENT_7732_REDEMPTION_WITNESS", policy["mandatoryConformanceCases"])


if __name__ == "__main__":
    unittest.main()
