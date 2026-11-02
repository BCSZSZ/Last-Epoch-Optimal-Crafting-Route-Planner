"""Explicit audit bootstrap: freeze a reviewed address index and installed hashes.

Run only when reviewing a new build. Ordinary extraction must never call this
script automatically to make a mismatching build appear verified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from extract_game_snapshot import ROOT, digest_file, encode_json


def main() -> None:
    import pefile
    import UnityPy

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, required=True)
    parser.add_argument("--method-index", type=Path, required=True)
    parser.add_argument("--audit-date", required=True)
    parser.add_argument("--accept-build", type=int, required=True)
    args = parser.parse_args()
    game = args.game_dir.resolve()
    manifest = (game.parents[1] / "appmanifest_899770.acf").read_text(encoding="utf-8")
    build = int(re.search(r'"buildid"\s+"(\d+)"', manifest)[1])
    if build != args.accept_build:
        raise ValueError("Installed Steam build differs from explicitly selected build.")
    environment = UnityPy.load(str(game / "Last Epoch_Data/globalgamemanagers"))
    versions = [obj.parse_as_dict(check_read=False)["bundleVersion"] for obj in environment.objects
                if obj.type.name == "PlayerSettings"]
    if len(versions) != 1:
        raise ValueError("PlayerSettings version is not unambiguous.")
    relatives = ("GameAssembly.dll", "Last Epoch_Data/il2cpp_data/Metadata/global-metadata.dat",
                 "Last Epoch_Data/StreamingAssets/LEAssetBundles/PermaLoad.bundle", "Last Epoch_Data/globalgamemanagers")
    files = {relative: {"sha256": digest_file(game / relative), "bytes": (game / relative).stat().st_size}
             for relative in relatives}
    source = json.loads(args.method_index.read_text(encoding="utf-8-sig"))
    binary = (game / "GameAssembly.dll").read_bytes()
    pe = pefile.PE(data=binary, fast_load=True)
    classes = {"ItemData", "ItemAffix", "ItemList", "CraftingManager", "AffixList", "EpochExtensions",
               "RngElement", "GenerateItems", "Affix", "Entry", "BaseEquipmentItem", "BaseEquipmentItem.SubType",
               "ClientShardStorage", "GlobalDataTracker", "SubTypeGroupExtensionMethods"}
    methods, seen = [], set()
    for key, entries in source.items():
        for entry in entries:
            if entry["name"].split("::")[0] not in classes and "AffixList/" not in entry["name"]:
                continue
            rva, length = int(key), int(entry["length"])
            identity = (entry["name"], rva, length)
            if identity in seen:
                continue
            seen.add(identity)
            offset = pe.get_offset_from_rva(rva)
            payload = binary[offset:offset + length]
            if length <= 0 or len(payload) != length:
                continue
            methods.append({"name": entry["name"], "rva": hex(rva), "length": length,
                            "sha256": hashlib.sha256(payload).hexdigest()})
    additional_path = ROOT / "research/additional-methods.json"
    if additional_path.exists():
        additional = json.loads(additional_path.read_text(encoding="utf-8"))
        if additional["assemblySha256"] != files["GameAssembly.dll"]["sha256"]:
            raise ValueError("Additional reviewed method labels belong to a different binary.")
        for entry in additional["methods"]:
            rva, length = int(entry["rva"], 0), entry["length"]
            offset = pe.get_offset_from_rva(rva)
            actual = hashlib.sha256(binary[offset:offset + length]).hexdigest()
            if actual != entry["sha256"]:
                raise ValueError(f"Additional reviewed method changed: {entry['name']}")
            if not any(int(row["rva"], 0) == rva and row["length"] == length for row in methods):
                methods.append({"name": entry["name"], "rva": hex(rva), "length": length, "sha256": actual})
    methods.sort(key=lambda row: (int(row["rva"], 0), row["name"]))
    audit = {"schemaVersion": 1, "gameVersion": versions[0], "steamBuildId": build,
             "auditedOn": args.audit_date, "files": files,
             "registrationScope": "Pins installed files and address labels; individual behavioral claims require separate code review."}
    registry = {"schemaVersion": 1, "assemblySha256": files["GameAssembly.dll"]["sha256"],
                "metadataSha256": files[relatives[1]]["sha256"],
                "addressIndexSha256": digest_file(args.method_index),
                "addressIndexOrigin": "Cpp2IL native method address map, re-read and pinned against this installed binary.",
                "interpretation": "Address/byte evidence registry. Presence is not proof that a method's behavior has been audited.",
                "methods": methods}
    (ROOT / "research").mkdir(exist_ok=True)
    (ROOT / "research/audited-build.json").write_bytes(encode_json(audit))
    (ROOT / "research/native-methods.json").write_bytes(encode_json(registry))
    print(json.dumps({"gameVersion": versions[0], "steamBuildId": build, "registeredMethodCount": len(methods)}))


if __name__ == "__main__":
    main()
