"""Build review indexes from committed audit evidence; never change game rules."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from extract_game_snapshot import ROOT, encode_json, load_json


def build_indexes(root: Path = ROOT) -> dict[str, bytes]:
    manifest = load_json(root / "data/game/1.5.3/manifest.json")
    rows, sources = [], []
    for label, path, methods_key in (
        ("affix", "research/affix-action-claims.json", "methodEvidence"),
        ("forge", "research/forge-fp-claims.json", "methods"),
    ):
        report = load_json(root / path)
        methods = {row["id"]: row for row in report[methods_key]}
        sources.append({"id": label, "path": path, "methodRangeCount": len(methods),
                        "sha256": hashlib.sha256((root / path).read_bytes()).hexdigest()})
        for claim in report["claims"]:
            refs = claim.get("evidenceRefs", claim.get("sources", []))
            rows.append({"id": f"{label}:{claim['id']}", "source": path,
                         "status": claim.get("confidence", claim.get("status")),
                         "claim": claim,
                         "methods": [{key: methods[ref][key] for key in ("id", "name", "rva", "length", "sha256")}
                                     for ref in refs]})
    matrix = {"schemaVersion": 1, "auditedOn": "2026-11-03", "gameVersion": manifest["gameVersion"],
              "steamBuildId": manifest["steamBuildId"], "dataRevision": manifest["dataRevision"],
              "interpretation": "VERIFIED refers to stated static local-code claims; not client testing or whole-engine validation.",
              "sources": sources, "claims": rows}
    required = ("research/audited-build.json", "research/affix-action-claims.json", "research/forge-fp-claims.json",
                "research/math-fixtures.json", "research/fp-examples.json", "data/game/1.5.3/manifest.json",
                "research/7710-route-cases.json", "research/7710-route-results.json", "research/7710-native-claims.json",
                "research/7710-monte-carlo.json")
    model = {"schemaVersion": 1, "modelId": "le-1.5.3-26087601-phase0-r2-unlimited-materials-7710",
             "phase": "PHASE_0_REVIEW", "productionReady": False,
             "gameVersion": manifest["gameVersion"], "steamBuildId": manifest["steamBuildId"],
             "dataRevision": manifest["dataRevision"],
             "fpDomain": {"minimum": 0, "maximum": 63, "defaultScoringDomain": list(range(1, 64)),
                          "weighting": "UNIFORM_PRODUCT_CONVENTION", "naturalDropDistribution": False},
             "defaultRngModel": "INDEPENDENT_NATIVE_GRID",
             "rngQualification": "Independent primitive outputs with native grids and operations; independence is a mathematical convention, not a proved property of a seeded client stream. Weighted grid boundaries remain a production precondition.",
             "referenceExampleModels": ["INDEPENDENT_NORMALIZED_WEIGHTS_AND_UNIFORM_PERMUTATIONS",
                                        "display_parameters_iid", "native_uniform_grid_iid"],
             "policies": {"failedRequiredSeal": "ABORT_AFTER_COMPLETE_NATIVE_SETTLEMENT",
                          "unacceptedRemoval": "ABORT_AFTER_COMPLETE_NATIVE_SETTLEMENT",
                          "fixedMacroOrder": True, "adaptiveReoptimization": False,
                          "macroStageLimitDraft": 12, "materialsAvailability": "UNLIMITED",
                          "materialCostInObjective": False, "inventoryInputSupported": False,
                          "materialUsageLimitsSupported": False, "materialAccountingDiagnosticOnly": True,
                          "tieBreakers": ["SUCCESS_CONDITIONAL_FP_MEAN", "FAILED_FP_WASTE", "SUCCESS_FP_P95", "SUCCESS_FP_P90", "MACRO_STAGES", "STABLE_ROUTE_ID"],
                          "mandatoryConformanceCases": ["direct_prefix_targets", "opposite_side_preparation"],
                          "successBeforeFpExhaustion": True, "policyAbortBeforeIncidentalSuccess": True},
             "deployment": {"priority": ["GITHUB_PAGES", "STREAMLIT_IF_PYTHON_NEEDED_AND_FITS", "USER_AWS"],
                            "audience": "PUBLIC_WITHOUT_LOGIN", "publicRepositoryAuthorizedIfPagesRequiresIt": True},
             "productionPreconditions": ["LEGACY_FORGE_OVERRIDE", "WEIGHTED_FLOAT_BOUNDARIES", "ALL_ROLL_DISPLAY_SEMANTICS",
                                         "APPROVE_RULE_MODEL_AND_OPTIMIZATION_OBJECTIVE"],
             "validationNotClaimed": ["PRODUCTION_TYPESCRIPT_ENGINE", "FULL_ROUTE_SEARCH", "BROWSER_PERFORMANCE",
                                      "LIVE_DEPLOYMENT", "GAME_CLIENT_CRAFTING_FREQUENCIES", "ONLINE_SERVER_PARITY"],
             "inputs": {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in required}}
    model["researchRevision"] = hashlib.sha256(encode_json(model)).hexdigest()
    return {"research/evidence-matrix.json": encode_json(matrix), "research/model-snapshot.json": encode_json(model)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    for relative, content in build_indexes().items():
        path = ROOT / relative
        if args.verify_only:
            if path.read_bytes() != content:
                raise ValueError(f"Stale review index: {relative}")
        else:
            path.write_bytes(content)
    print(json.dumps({"indexes": 2, "verifiedOnly": args.verify_only}))


if __name__ == "__main__":
    main()
