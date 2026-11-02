"""End-to-end conformance and arithmetic checks for the user's 7710 routes."""
from fractions import Fraction
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from check_7710_routes import DISPLAY, Evaluator, Interval, check_structural_cases, load_cases


class User7710RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload, cls.definitions = load_cases()
        cls.direct, cls.swap = cls.payload["cases"]

    def evaluator(self, case=None, fp_type="NORMAL"):
        case = self.direct if case is None else case
        return Evaluator(case, case["routes"][0], fp_type, DISPLAY, self.definitions)

    def state(self, case=None):
        case = self.direct if case is None else case
        return tuple((row["id"], row["tier"], row["sealed"]) for row in case["initialAffixes"])

    def tearDown(self):
        Evaluator.evaluate.cache_clear()
        Evaluator.action.cache_clear()
        Evaluator.fp_kernel.cache_clear()
        Evaluator.critical_kernel.cache_clear()

    def test_normal_add_has_both_critical_branches(self):
        evaluator = self.evaluator()
        exits = evaluator.action("ADD_A", self.state(), 63)
        junk_upgraded = sum(p for state, _, _, p in exits if any(identity == 2 and tier == 2 for identity, tier, _ in state))
        target_upgraded = sum(p for state, _, _, p in exits if any(identity == 4 and tier == 2 for identity, tier, _ in state))
        self.assertEqual(junk_upgraded, Fraction(3, 50))
        self.assertEqual(target_upgraded, Fraction(3, 50))
        self.assertTrue(all(after == 63 for state, after, _, _ in exits if any(row[1] == 2 for row in state)))

    def test_sealing_is_certain_only_when_garbage_is_still_t1(self):
        evaluator = self.evaluator()
        full = self.state() + ((4, 1, False),)
        self.assertEqual(evaluator.seal_probability(full, 2), 1)
        upgraded = full[:2] + ((2, 2, False),) + full[3:]
        self.assertEqual(evaluator.seal_probability(upgraded, 2), Fraction(69, 100))

    def test_failed_seal_is_settled_then_aborted_even_when_critical_refunds_fp(self):
        evaluator = self.evaluator()
        state = self.state()[:2] + ((2, 2, False), (4, 1, False))
        exits = evaluator.action("SEAL_CURRENT_JUNK", state, 63)
        self.assertEqual(sum(p for _, _, abort, p in exits if abort), Fraction(31, 100))
        self.assertEqual(sum(p for _, after, abort, p in exits if abort and after == 63), Fraction(93, 2500))

    def test_prepare_step_can_move_a_t1_to_b_side_but_cannot_move_identity_sides(self):
        evaluator = self.evaluator(self.swap)
        added = self.state(self.swap) + ((7, 1, False),)
        self.assertFalse(evaluator.junk(added, only_t1=True))
        self.assertEqual(evaluator.can_add(added, 4), "NO_LEGAL_PREFIX_SLOT")
        prepared = ((2, 1, False), (26, 7, False), (10, 1, False), (7, 7, False))
        self.assertEqual(evaluator.junk(prepared, only_t1=True), [0])
        sealed = ((2, 1, True),) + prepared[1:]
        self.assertIsNone(evaluator.can_add(sealed, 4))

    def test_nominal_prepare_hits_in_all_five_changed_7711_layouts(self):
        result = check_structural_cases(self.payload, self.definitions)
        self.assertEqual(result["nominalPrepChangedLayouts"], 5)
        self.assertEqual(result["nominalPrepHitGivenChanged"], "1")

    def test_sealed_item_at_zero_fp_cannot_add_b(self):
        evaluator = self.evaluator()
        sealed = ((2, 1, True), (7, 7, False), (10, 7, False), (4, 1, False))
        result = evaluator.evaluate(2, sealed, 0)
        self.assertEqual((result.p.hi, result.attempts.hi), (0, 0))

    def test_goal_at_zero_fp_is_success(self):
        evaluator = self.evaluator()
        goal = ((2, 1, True), (7, 1, False), (10, 1, False), (4, 7, False), (5, 7, False))
        result = evaluator.evaluate(4, goal, 0)
        self.assertEqual((result.p.lo, result.p.hi, result.attempts.hi), (1, 1, 0))

    def test_reference_file_includes_preparation_costs_and_rejects_no_prep_swap(self):
        artifact = json.loads((ROOT / "research/7710-route-results.json").read_text(encoding="utf-8"))
        self.assertTrue(artifact["materialsUnlimited"])
        self.assertFalse(artifact["materialCostInObjective"])
        scenarios = artifact["profiles"][0]["scenarios"]
        no_prep = [row for row in scenarios if row["routeId"] == "without_required_preparation"]
        self.assertEqual(len(no_prep), 3)
        self.assertTrue(all(point["successProbability"]["upper"] == 0 for row in no_prep for point in row["points"]))
        main = next(row for row in scenarios if row["routeId"] == "direct_fill_seal_add_havoc" and row["fpType"] == "NORMAL")
        self.assertGreater(main["points"][30]["expectedAttempts"]["lower"], 3)
        self.assertLess(main["points"][30]["successProbability"]["upper"], 0.5)

    def test_materials_are_fixed_unlimited_and_never_a_ranking_axis(self):
        model = json.loads((ROOT / "research/model-snapshot.json").read_text(encoding="utf-8"))
        policy = model["policies"]
        self.assertEqual(policy["materialsAvailability"], "UNLIMITED")
        self.assertFalse(policy["materialCostInObjective"])
        self.assertFalse(policy["inventoryInputSupported"])
        self.assertNotIn("materialWeightsDefault", policy)
        self.assertFalse(any("MATERIAL" in axis for axis in policy["tieBreakers"]))

    def test_interval_operations_enclose_exact_rational_results(self):
        for a, b in ((Fraction(1, 3), Fraction(7, 11)), (Fraction(123, 29), Fraction(5, 17))):
            x, y = Interval.exact(a), Interval.exact(b)
            for interval, expected in ((x + y, a + b), (x * y, a * b), (x / y, a / b)):
                self.assertLessEqual(Fraction.from_float(interval.lo), expected)
                self.assertGreaterEqual(Fraction.from_float(interval.hi), expected)


if __name__ == "__main__":
    unittest.main()
