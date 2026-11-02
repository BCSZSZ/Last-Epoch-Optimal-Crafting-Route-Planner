"""Meaningful data-integrity and version-drift checks for Phase 0 tooling."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from check_math_fixtures import check_fixtures, FixtureCheckError
from extract_game_snapshot import encode_json, project_assets, read_installed
from validate_research import validate_snapshot, validate_documents


class InstalledFingerprintTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.game = Path(self.temporary.name) / "steamapps/common/Last Epoch"
        self.game.mkdir(parents=True)
        self.manifest = self.game.parents[1] / "appmanifest_899770.acf"
        self.manifest.write_text('"buildid" "26087601"', encoding="utf-8")
        (self.game / "GameAssembly.dll").write_bytes(b"reviewed binary")
        self.expected = {"steamBuildId": 26087601, "files": {
            "GameAssembly.dll": {"sha256": hashlib.sha256(b"reviewed binary").hexdigest()}}}

    def test_accepts_exact_pinned_input(self) -> None:
        actual = read_installed(self.game, self.expected)
        self.assertEqual(actual["steamBuildId"], 26087601)

    def test_new_steam_build_requires_a_new_audit(self) -> None:
        self.manifest.write_text('"buildid" "26087602"', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "new audit"):
            read_installed(self.game, self.expected)

    def test_changed_binary_cannot_be_relabelled_with_old_rules(self) -> None:
        (self.game / "GameAssembly.dll").write_bytes(b"changed after update")
        with self.assertRaisesRegex(ValueError, "refusing to relabel"):
            read_installed(self.game, self.expected)


class ResearchIntegrityTests(unittest.TestCase):
    def test_unity_64_bit_identifiers_survive_javascript_json_boundary(self) -> None:
        value = {"pathId": 2955332227439360059, "affixId": 4, "maxSafe": (1 << 53) - 1}
        encoded = json.loads(encode_json(value))
        self.assertEqual(encoded["pathId"], "2955332227439360059")
        self.assertEqual(encoded["affixId"], 4)
        self.assertIsInstance(encoded["maxSafe"], int)

    def test_snapshot_all_catalogues_and_reviewed_method_refs(self) -> None:
        result = validate_snapshot()
        self.assertEqual((result["affixes"], result["bases"], result["behaviorClaims"]), (1156, 923, 18))

    def test_duplicate_ids_across_single_and_multi_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "Duplicate affix IDs"):
            project_assets({"MasterAffixesList": {"singleAffixes": [{"affixId": 1}], "multiAffixes": [{"affixId": 1}]}})

    def test_math_fixture_with_false_probability_mass_is_rejected(self) -> None:
        payload = json.loads((ROOT / "research/math-fixtures.json").read_text(encoding="utf-8"))
        payload["cases"][0]["transitions"][0]["p"] = "1/2"
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "corrupt-fixtures.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(FixtureCheckError):
                check_fixtures(path)

    def test_wrong_success_conditioned_mean_is_rejected(self) -> None:
        payload = json.loads((ROOT / "research/math-fixtures.json").read_text(encoding="utf-8"))
        case = next(row for row in payload["cases"] if row["id"] == "success-conditioned-budget-mixture")
        case["expected"]["actualFPSpentGivenSuccessMean"] = "3/2"
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "wrong-conditional-mean.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(FixtureCheckError):
                check_fixtures(path)

    def test_synthetic_probabilities_cannot_be_labelled_game_mechanics(self) -> None:
        payload = json.loads((ROOT / "research/math-fixtures.json").read_text(encoding="utf-8"))
        payload["notGameMechanics"] = False
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "mislabelled-fixtures.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(FixtureCheckError):
                check_fixtures(path)

    def test_document_package_is_standalone_and_original_bootstrap_unchanged(self) -> None:
        result = validate_documents()
        self.assertEqual(result["requiredDocuments"], 11)
        self.assertTrue(result["bootstrapUnchanged"])


if __name__ == "__main__":
    unittest.main()
