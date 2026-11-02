"""Extract this audit's pinned installed game into deterministic research data.

No imports, files or network services from the parent LE-filter project are used.
This is a research extractor, not the production crafting/optimization engine.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "research/audited-build.json"
REGISTRY = ROOT / "research/native-methods.json"
OBJECTS = {331809119198608226: "MasterItemsList", 2955332227439360059: "MasterAffixesList"}


def digest_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def json_safe_integers(value: object) -> object:
    """Keep 64-bit Unity object IDs exact when future JS clients parse JSON."""
    if isinstance(value, dict):
        return {key: json_safe_integers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe_integers(item) for item in value]
    if isinstance(value, int) and abs(value) > (1 << 53) - 1:
        return str(value)
    return value


def encode_json(value: object) -> bytes:
    return (json.dumps(json_safe_integers(value), ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def assert_unique(values: list, key: str, label: str) -> None:
    counts = Counter(row[key] for row in values)
    duplicates = [identity for identity, count in counts.items() if count > 1]
    if duplicates:
        raise ValueError(f"Duplicate {label}: {duplicates}")


def read_installed(game: Path, expected: dict) -> dict:
    """Reject version drift before parsing or writing any output."""
    manifest = game.parents[1] / "appmanifest_899770.acf"
    build = re.search(r'"buildid"\s+"(\d+)"', manifest.read_text(encoding="utf-8"))
    if not build or int(build[1]) != expected["steamBuildId"]:
        raise ValueError("Steam build differs from the audited build; a new audit is required.")
    hashes = {}
    for relative, known in expected["files"].items():
        actual = digest_file(game / relative)
        if actual != known["sha256"]:
            raise ValueError(f"Audited file changed: {relative}; refusing to relabel old mechanics.")
        hashes[relative] = actual
    return {"steamBuildId": int(build[1]), "files": hashes}


def extract_assets(game: Path) -> tuple[dict, list, str]:
    import UnityPy

    bundle = game / "Last Epoch_Data/StreamingAssets/LEAssetBundles/PermaLoad.bundle"
    environment = UnityPy.load(str(bundle))
    values, evidence = {}, []
    for obj in environment.objects:
        if obj.path_id not in OBJECTS:
            continue
        name = OBJECTS[obj.path_id]
        definition = obj.parse_as_dict(check_read=True)
        if definition.get("m_Name") != name:
            raise ValueError(f"Unexpected object at {obj.path_id}")
        values[name] = definition
        evidence.append({"name": name, "pathId": obj.path_id, "rawByteLength": obj.byte_size,
                         "rawSha256": hashlib.sha256(obj.get_raw_data()).hexdigest()})
    if len(values) != len(OBJECTS):
        raise ValueError("Missing required asset objects; no partial catalogue is accepted.")
    managers = UnityPy.load(str(game / "Last Epoch_Data/globalgamemanagers"))
    versions = [obj.parse_as_dict(check_read=False)["bundleVersion"] for obj in managers.objects
                if obj.type.name == "PlayerSettings"]
    if len(versions) != 1:
        raise ValueError("Expected exactly one PlayerSettings version.")
    return values, sorted(evidence, key=lambda row: row["name"]), versions[0]


def project_assets(values: dict) -> tuple[dict, dict, dict]:
    """Retain all affix definitions, including exceptional and legacy entries."""
    affix_list = values["MasterAffixesList"]
    affixes = []
    for collection in ("singleAffixes", "multiAffixes"):
        for ordinal, definition in enumerate(affix_list[collection]):
            affixes.append({"id": definition["affixId"], "sourceCollection": collection,
                            "sourceOrdinal": ordinal, "definition": definition})
    assert_unique(affixes, "id", "affix IDs")
    affixes.sort(key=lambda row: row["id"])
    item_list = values["MasterItemsList"]
    item_types, bases = [], []
    for ordinal, definition in enumerate(item_list["EquippableItems"]):
        base_type = definition["baseTypeID"]
        item_types.append({"id": base_type, "sourceOrdinal": ordinal,
                           "definition": {key: val for key, val in definition.items() if key != "subItems"}})
        for base_ordinal, base in enumerate(definition["subItems"]):
            bases.append({"id": f"{base_type}:{base['subTypeID']}", "baseTypeId": base_type,
                          "subTypeId": base["subTypeID"], "sourceOrdinal": base_ordinal, "definition": base})
    assert_unique(item_types, "id", "item type IDs")
    assert_unique(bases, "id", "base IDs")
    parameters = {key: item_list[key] for key in (
        "iceForgingPotentialPreservationChance", "bloodForgingPotentialExtraCriticalSuccessChance")}
    return ({"schemaVersion": 1, "affixes": affixes},
            {"schemaVersion": 1, "itemTypes": item_types, "bases": bases},
            {"schemaVersion": 1, "parameters": parameters,
             "interpretation": "Raw float32 resource parameters, not unconditional operation probabilities."})


def extract_methods(game: Path, registry: dict, assembly_sha: str) -> dict:
    import pefile

    if registry["assemblySha256"] != assembly_sha:
        raise ValueError("Native method registry belongs to a different game binary.")
    binary = (game / "GameAssembly.dll").read_bytes()
    pe = pefile.PE(data=binary, fast_load=True)
    methods = []
    for entry in registry["methods"]:
        rva = int(entry["rva"], 0)
        offset = pe.get_offset_from_rva(rva)
        payload = binary[offset:offset + entry["length"]]
        actual = hashlib.sha256(payload).hexdigest()
        if len(payload) != entry["length"] or actual != entry["sha256"]:
            raise ValueError(f"Method bytes changed: {entry['name']} at {entry['rva']}")
        methods.append({**entry, "fileOffset": offset})
    return {"schemaVersion": 1, "assemblySha256": assembly_sha, "methods": methods}


def build_snapshot(game: Path) -> dict[str, bytes]:
    expected = load_json(AUDIT)
    registry = load_json(REGISTRY)
    installed = read_installed(game, expected)
    values, objects, version = extract_assets(game)
    if version != expected["gameVersion"]:
        raise ValueError("PlayerSettings version differs from audited version.")
    affixes, items, parameters = project_assets(values)
    methods = extract_methods(game, registry, installed["files"]["GameAssembly.dll"])
    payloads = {"affixes.json": encode_json(affixes), "items.json": encode_json(items),
                "resource-parameters.json": encode_json(parameters), "native-evidence.json": encode_json(methods)}
    stats = {"affixCount": len(affixes["affixes"]), "singleAffixCount": len(values["MasterAffixesList"]["singleAffixes"]),
             "multiAffixCount": len(values["MasterAffixesList"]["multiAffixes"]),
             "itemTypeCount": len(items["itemTypes"]), "baseCount": len(items["bases"]),
             "specialAffixTypeCounts": dict(sorted(Counter(str(row["definition"]["specialAffixType"])
                                                           for row in affixes["affixes"]).items())),
             "registeredNativeMethodCount": len(methods["methods"])}
    manifest = {"schemaVersion": 1, "gameVersion": version, "steamBuildId": installed["steamBuildId"],
                "auditedOn": expected["auditedOn"], "timezone": "Asia/Tokyo", "installedFiles": expected["files"],
                "assetObjects": objects, "counts": stats,
                "playerSettingsRead": "check_read=False for PlayerSettings tail compatibility; main databases use check_read=True.",
                "integerEncoding": "Integers outside JavaScript safe integer range are decimal strings; ordinary affix/base IDs remain numbers.",
                "artifacts": {name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
                              for name, content in sorted(payloads.items())},
                "toolVersions": {name: importlib.metadata.version(name) for name in ("UnityPy", "capstone", "pefile")}}
    manifest["dataRevision"] = hashlib.sha256(encode_json(manifest)).hexdigest()
    payloads["manifest.json"] = encode_json(manifest)
    return payloads


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data/game/1.5.3")
    parser.add_argument("--verify-only", action="store_true", help="Re-extract in memory and compare; write nothing.")
    args = parser.parse_args()
    payloads = build_snapshot(args.game_dir.resolve())
    if args.verify_only:
        for name, content in payloads.items():
            if (args.output_dir / name).read_bytes() != content:
                raise ValueError(f"Snapshot is not reproducible: {name}")
    else:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for name, content in payloads.items():
            (args.output_dir / name).write_bytes(content)
    manifest = json.loads(payloads["manifest.json"])
    print(json.dumps({"verifiedOnly": args.verify_only, "gameVersion": manifest["gameVersion"],
                      "dataRevision": manifest["dataRevision"], "counts": manifest["counts"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as exc:
        print(f"Extraction failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
