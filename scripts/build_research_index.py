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
                "research/7710-monte-carlo.json", "research/common-pattern-cases.json",
                "research/common-pattern-results.json", "research/common-pattern-monte-carlo.json",
                "research/7732-redemption-reference.json", "research/legacy-forge-compatibility.json",
                "research/crafting-level-claims.json", "research/reference-calculators.json",
                "research/browser-memory/7710-normal-memory.json", "research/browser-memory/7710-normal-input.json",
                "research/browser-memory/7710-normal-plan.json", "research/browser-memory/validation.json",
                "research/device-validation/desktop-baseline.json", "research/device-validation/desktop-baseline-validation.json",
                "research/device-validation/public-normal.json", "research/device-validation/public-normal-validation.json",
                "src/generated/model.json", "research/hierarchy-validation.json", "research/hierarchy-runtime-benchmark.json",
                "research/runtime-model-archive/manifest.json", "research/ui-validation/parity.json", "research/acquisition-order.json",
                "src/core/policy.json", "research/fp65-budget48.json", "research/7710-7721-completion.json",
                "research/ui-validation/completion48-parity.json", "research/ui-validation/public-completion48-parity.json",
                "research/static-deployment.json", "research/deployment-completion48.json",
                "research/ui-validation/slot-targets-local-parity.json", "research/ui-validation/slot-targets-public-parity.json",
                "research/deployment-slot-targets.json", "research/7271-route-comparison.json",
                "research/ui-validation/capacity-local-parity.json", "research/ui-validation/capacity-public-parity.json",
                "research/deployment-capacity-seal.json", "research/affix-localization.json",
                "research/detailed-performance.json", "research/localization-bundle-comparison.json",
                "research/ui-validation/detailed-local-parity.json")
    model = {"schemaVersion": 2, "modelId": "le-1.5.3-26087601-r12-detailed-locale",
             "phase": "PUBLIC_PREVIEW", "productionReady": False,
             "productionModelId": load_json(root / "src/generated/model.json")["modelId"],
             "userInput": {"contract": "docs/minimal-ui.md", "assumeForgeable": True,
                           "optionalAffixIdentities": True, "countsSplitByPrefixSuffix": True,
                           "defaultEquipmentPart": "ANY_UNSPECIFIED", "explicitStartingSlotOwnership": True,
                           "ownedCountersReadOnly": True, "savedDraftVersion": 3,
                           "totalT7GoalsBoundedByOrdinarySourceT7": True,
                           "locale": "zh-CN", "localizedAffixes": 1156,
                           "localizationEvidence": "research/affix-localization.json",
                           "unspecifiedEquipmentModel": "FORGEABLE_ANY_EQUAL",
                           "defaultAnonymousPool": "FORGEABLE_EQUAL", "knownIdentityPool": "FORGEABLE_WEIGHTED",
                           "bothReferencePoolsAllClassesPerItemType": True, "auditedApiPreserved": True,
                           "uiWorkerParity": "research/ui-validation/capacity-public-parity.json",
                           "localUiWorkerParity": "research/ui-validation/detailed-local-parity.json",
                           "historicalPublicUiWorkerParity": "research/ui-validation/public-completion48-parity.json"},
             "userApproval": {"date": "2026-11-03", "codeDerivedRulesSufficient": True, "clientBitExactRequired": False},
             "gameVersion": manifest["gameVersion"], "steamBuildId": manifest["steamBuildId"],
             "dataRevision": manifest["dataRevision"],
             "fpDomain": {"minimum": 0, "maximum": 63, "defaultScoringDomain": [],
                          "weighting": "NOT_USED_IN_INTRINSIC_V2", "naturalDropDistribution": False},
             "productionMetric": {"kind": "INTRINSIC_V2", "minimumSuccess": 0.15,
                                  "maximumSuccessfulMeanFp": load_json(root / "src/generated/model.json")["practicalPolicy"]["maximumSuccessFp"],
                                  "conditionalOnFinalSuccess": True, "upperInputLabels": 28, "upperRouteNodes": 23,
                                  "completionMetric": {"initialFp": 48, "includesOperationNgAndFpExhaustion": True,
                                                       "notRecommendedBelow": 0.25, "recommendedAbove": 0.65,
                                                       "strictBoundaries": True, "rankingUnchanged": True,
                                                       "method": "CERTIFIED_FINITE_BALANCE_RECURRENCE"},
                                  "vacancyAwareInterleavedAcquisition": True,
                                  "preflightCertificates": ["STANDARD_T4_SEAL_REMOVAL", "PURE_SINGLE_CAST_DOUBLE_HIT", "PURE_UNLIMITED_DOUBLE_HIT_SUCCESS_FP"],
                                  "preflightDoesNotBlacklistAllRedemptionOrHighTierSources": True,
                                  "finiteFpBoundaryBenefitsApplied": False},
             "defaultRngModel": "DISPLAY_PARAMETERS_INDEPENDENT_DRAWS_V1",
             "rngQualification": "Audited native control flow, binary64 nominal thresholds, current normalized craft weights, independent draws and uniform changed Havoc layouts. Arithmetic enclosures do not enclose all differences from native seeded-client RNG.",
             "referenceExampleModels": ["INDEPENDENT_NORMALIZED_WEIGHTS_AND_UNIFORM_PERMUTATIONS",
                                        "display_parameters_iid", "native_uniform_grid_iid"],
             "policies": {"failedRequiredSeal": "ABORT_AFTER_COMPLETE_NATIVE_SETTLEMENT",
                          "unacceptedRemoval": "ABORT_AFTER_COMPLETE_NATIVE_SETTLEMENT",
                          "fixedMacroOrder": True, "adaptiveReoptimization": False,
                          "macroStageLimitDraft": 12, "materialsAvailability": "UNLIMITED",
                          "materialCostInObjective": False, "inventoryInputSupported": False,
                          "materialUsageLimitsSupported": False, "materialAccountingDiagnosticOnly": True,
                          "tieBreakers": ["SUCCESS_CONDITIONAL_FP_MEAN", "STABLE_ROUTE_ID"],
                          "patternSearchPriority": ["TARGET_IDENTITIES_ALREADY_PRESENT", "ONE_TARGET_ALREADY_T7_771X",
                                                    "MISSING_BOTH_TARGETS_7710", "OTHER_LEGAL_INPUTS"],
                          "commonPatternsPrioritizedNotExclusive": True,
                          "macroStatistics": "JOINT_FP_MOMENTS_CONDITIONAL_ON_FINAL_SUCCESS",
                          "samplingCoverage": "NO_PRODUCTION_SAMPLING_IN_INTRINSIC_V2",
                          "unassessedPatternStatus": "UNASSESSED", "uncompletedSearchStatus": "INCOMPLETE",
                          "mandatoryConformanceCases": ["direct_prefix_targets", "opposite_side_preparation",
                                                        "EXISTING_A_DIRECT_X1_TO_X7", "EXISTING_A_PREPARE_X1_TO_X7",
                                                        "X0_REQUIRES_FOUR_ORDINARY_SLOTS", "TARGET_IDENTITIES_AT_T3_T2_7732",
                                                        "ALL_TARGETS_ABSENT_7732_REDEMPTION_WITNESS"],
                          "finiteFpExhaustionOnlyInHistoricalBaseline": False, "finiteFpExhaustionInCompletion": True,
                          "policyAbortBeforeIncidentalSuccess": True},
             "deployment": {"priority": ["GITHUB_PAGES", "STREAMLIT_IF_PYTHON_NEEDED_AND_FITS", "USER_AWS"],
                            "audience": "PUBLIC_WITHOUT_LOGIN", "publicRepositoryAuthorizedIfPagesRequiresIt": True,
                            "publicPreviewUrl": "https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/",
                            "liveStaticValidation": "research/static-deployment.json"},
             "remainingAcceptance": ["PHYSICAL_LOW_END_DEVICE"],
             "acceptanceDeferrals": [{"requirement": "PHYSICAL_LOW_END_DEVICE", "date": "2026-11-03",
                                      "userResponse": "目前没有，保留待验收项", "status": "PENDING_DEVICE_AVAILABILITY",
                                      "requirementWaived": False}],
             "browserMemoryEvidence": {"record": "research/browser-memory/validation.json",
                                       "historicalModelId": "le-1.5.3-iid-f58515921fd9cbcc", "certifiesCurrentRelease": False,
                                       "method": "NATIVE_POST_GC_MEMORY_ESTIMATES_WITH_WORKER_ATTRIBUTION",
                                       "observedSampleMaximumNotAllocationPeak": True},
             "deviceValidation": {"page": "https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/device-check/",
                                  "archivedRecordsModelId": "le-1.5.3-iid-f58515921fd9cbcc", "archivedRecordsCertifyCurrentRelease": False,
                                  "currentNodeBenchmark": "research/hierarchy-runtime-benchmark.json",
                                  "desktopRecord": "research/device-validation/desktop-baseline.json",
                                  "publicRecord": "research/device-validation/public-normal.json", "publicMatrixCases": 5,
                                  "desktopMatrixCases": 15, "physicalLowEndTestCompleted": False},
             "deferredResearch": ["WEIGHTED_NATIVE_GRID_BOUNDARIES", "MULTI_PROPERTY_ROLL_DISPLAY_PROJECTION", "CLIENT_FREQUENCIES"],
             "validationNotClaimed": ["UNBOUNDED_GLOBAL_OPTIMALITY", "PHYSICAL_LOW_END_DEVICE", "BROWSER_INSTANTANEOUS_ALLOCATION_PEAK",
                                      "GAME_CLIENT_CRAFTING_FREQUENCIES", "ONLINE_SERVER_PARITY"],
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
