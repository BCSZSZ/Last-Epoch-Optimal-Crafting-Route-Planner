"""Validate the Phase 0 review package using only committed data and stdlib."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

from build_research_index import build_indexes
from extract_game_snapshot import ROOT, encode_json, load_json

BOOTSTRAP_SHA256 = "78aef7af8eee44ae4fa7bffa40d217b0a39a5b7d0fab453e38608ccb5702c82d"
REQUIRED_DOCS = ("PRD", "mechanics", "affix-database", "probability-model", "state-model", "macro-actions",
                 "optimization-objective", "route-search", "validation-plan", "implementation-plan", "open-questions")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_snapshot(root: Path = ROOT) -> dict:
    data = root / "data/game/1.5.3"
    manifest = load_json(data / "manifest.json")
    audit = load_json(root / "research/audited-build.json")
    require(manifest["gameVersion"] == audit["gameVersion"] == "1.5.3", "Game version mismatch")
    require(manifest["steamBuildId"] == audit["steamBuildId"] == 26087601, "Steam build mismatch")
    require(manifest["installedFiles"] == audit["files"], "Installed file fingerprints mismatch")
    revision_payload = {key: val for key, val in manifest.items() if key != "dataRevision"}
    require(hashlib.sha256(encode_json(revision_payload)).hexdigest() == manifest["dataRevision"], "Data revision mismatch")
    for name, expected in manifest["artifacts"].items():
        path = data / name
        require(path.is_file() and sha(path) == expected["sha256"] and path.stat().st_size == expected["bytes"],
                f"Artifact mismatch: {name}")
    affixes = load_json(data / "affixes.json")["affixes"]
    items = load_json(data / "items.json")
    require(len({row["id"] for row in affixes}) == len(affixes) == 1156, "Incomplete or duplicate affix IDs")
    require(all(row["id"] == row["definition"]["affixId"] for row in affixes), "Affix identity mismatch")
    require(len({row["id"] for row in items["bases"]}) == len(items["bases"]) == 923, "Incomplete or duplicate base IDs")
    require(len({row["id"] for row in items["itemTypes"]}) == len(items["itemTypes"]) == 42, "Item types mismatch")
    for row in items["bases"]:
        require(row["id"] == f"{row['baseTypeId']}:{row['subTypeId']}" and
                row["subTypeId"] == row["definition"]["subTypeID"], "Base identity mismatch")
    registry = load_json(root / "research/native-methods.json")
    recorded = load_json(data / "native-evidence.json")
    require(registry["assemblySha256"] == audit["files"]["GameAssembly.dll"]["sha256"], "Registry binary mismatch")
    require([{k: val for k, val in row.items() if k != "fileOffset"} for row in recorded["methods"]] == registry["methods"],
            "Snapshot method registry mismatch")
    lookup = {(int(row["rva"], 0), row["length"]): row["sha256"] for row in registry["methods"]}
    reviewed, claims = set(), 0
    for relative, methods_key, assembly_key in (
        ("research/affix-action-claims.json", "methodEvidence", "assemblySha256"),
        ("research/forge-fp-claims.json", "methods", "gameAssemblySha256"),
    ):
        report = load_json(root / relative)
        require(report[assembly_key] == registry["assemblySha256"], f"Audit binary mismatch: {relative}")
        methods = {row["id"]: row for row in report[methods_key]}
        require(len(methods) == len(report[methods_key]), f"Duplicate evidence IDs in {relative}")
        for entry in methods.values():
            key = (int(entry["rva"], 0), entry["length"])
            require(lookup.get(key) == entry["sha256"], f"Method evidence mismatch: {entry['name']}")
            reviewed.add(key)
        for claim in report["claims"]:
            status = claim.get("confidence", claim.get("status"))
            require(status in {"VERIFIED", "PARTIALLY_VERIFIED", "ESTIMATED", "UNKNOWN"}, "Invalid evidence confidence")
            refs = claim.get("evidenceRefs", claim.get("sources", []))
            require(bool(refs) and all(ref in methods for ref in refs), f"Broken method references: {claim['id']}")
            claims += 1
    return {"dataRevision": manifest["dataRevision"], "affixes": len(affixes), "itemTypes": 42, "bases": 923,
            "registeredMethodRanges": len(registry["methods"]), "reviewedDistinctMethodRanges": len(reviewed), "behaviorClaims": claims}


def validate_documents(root: Path = ROOT, allow_pending_report: bool = False) -> dict:
    for name in REQUIRED_DOCS:
        path = root / f"docs/{name}.md"
        require(path.is_file() and len(path.read_text(encoding="utf-8").strip()) > 100, f"Missing substantive document: {name}")
    require(sha(root / "BOOTSTRAP.md") == BOOTSTRAP_SHA256, "Original bootstrap was changed")
    links = 0
    paths = [root / "README.md", *sorted((root / "docs").rglob("*.md")), root / "research/README.md"]
    for path in paths:
        for target in re.findall(r"(?<!!)\[[^\]]+\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
            parsed = urlsplit(target.strip("<>"))
            if parsed.scheme or not parsed.path:
                continue
            resolved = (path.parent / unquote(parsed.path)).resolve()
            require(resolved.is_relative_to(root.resolve()), f"Documentation reaches outside standalone project: {path.name}")
            require(resolved.exists() or (allow_pending_report and resolved == root / "research/validation.json"),
                    f"Broken local link in {path.name}: {target}")
            links += 1
    return {"requiredDocuments": len(REQUIRED_DOCS), "localLinks": links, "bootstrapUnchanged": True}


def run_example(script: str, *arguments: str) -> dict:
    result = subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "scripts" / script), *arguments],
                            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=False)
    require(result.returncode == 0, f"{script} failed: {result.stderr[-3000:]}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    require(bool(lines), f"{script} produced no summary")
    return json.loads(lines[-1])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()
    snapshot = validate_snapshot()
    for relative, content in build_indexes().items():
        require((ROOT / relative).read_bytes() == content, f"Stale index: {relative}")
    documents = validate_documents(allow_pending_report=args.write_report)
    checks = {"math": run_example("check_math_fixtures.py"), "actions": run_example("check_action_examples.py"),
              "fp": run_example("check_fp_examples.py", "--verify-only"),
              "user7710": run_example("check_7710_routes.py", "--verify-only"),
              "user7710MonteCarlo": run_example("check_7710_monte_carlo.py", "--summary", "--no-timing")}
    checks["user7710MonteCarlo"].pop("elapsedSeconds", None)
    model = load_json(ROOT / "research/model-snapshot.json")
    require(model["policies"]["materialsAvailability"] == "UNLIMITED" and
            model["policies"]["materialCostInObjective"] is False and
            model["policies"]["inventoryInputSupported"] is False,
            "User's unlimited-material policy is not reflected in the model")
    saved_mc = load_json(ROOT / "research/7710-monte-carlo.json")
    require(saved_mc["passed"] is True and saved_mc["fixtureSha256"] == sha(ROOT / "research/7710-route-cases.json") and
            saved_mc["referenceResultsSha256"] == sha(ROOT / "research/7710-route-results.json"),
            "Stale complete-route Monte Carlo baseline")
    report = {"schemaVersion": 1, "auditedOn": "2026-11-03", "status": "PASS", "phase": "PHASE_0_RESEARCH_ONLY",
              "snapshot": snapshot, "documents": documents, "checks": checks,
              "claimedClientTest": False, "claimedProductionSolverTest": False,
              "inputs": {str(path.relative_to(ROOT)).replace("\\", "/"): sha(path)
                         for path in sorted((ROOT / "scripts").glob("*.py"))}}
    if args.write_report:
        (ROOT / "research/validation.json").write_bytes(encode_json(report))
    print(json.dumps({"status": "PASS", "snapshot": snapshot, "documents": documents,
                      "mathChecks": checks["math"]["rationalChecks"], "fpMassCases": checks["fp"]["exactUnitMassCases"],
                      "actionMonteCarloSamples": sum(row["samples"] for row in checks["actions"]["redemption"]),
                      "user7710Scenarios": checks["user7710"]["scenarios"],
                      "completeRouteMonteCarloSamples": checks["user7710MonteCarlo"]["totalSamples"],
                      "wroteReport": args.write_report}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(f"Research validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
