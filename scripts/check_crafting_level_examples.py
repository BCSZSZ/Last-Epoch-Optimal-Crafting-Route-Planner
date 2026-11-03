#!/usr/bin/env python3
"""Reproduce the audited 1.5.3 level helpers; optionally verify local native bytes.

Standard library only. This is an independent research reference, not a game
client experiment or a production action engine. Public inputs use display tiers;
the three native hypothetical-tier helpers use stored tiers (display tier - 1).
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct


ROOT = Path(__file__).resolve().parents[1]
CLAIMS = ROOT / "research" / "crafting-level-claims.json"
TIER_LEVELS = (1, 3, 6, 10, 14, 15)


def tier_level(stored_tier: int) -> int:
    if not isinstance(stored_tier, int) or not 0 <= stored_tier <= 255:
        raise ValueError("Reference input must be a valid nonnegative stored tier")
    return TIER_LEVELS[stored_tier] if stored_tier < 6 else 16


def contributes(affix: dict) -> bool:
    return affix["specialAffixType"] == 0 and affix["sealedAffixType"] == 0


def affix_requirement(affixes: list[dict]) -> int:
    eligible = [affix for affix in affixes if contributes(affix)]
    stored = [affix["displayTier"] - 1 for affix in eligible]
    highest = max(stored, default=0)
    raw = -10 + sum(tier_level(tier) for tier in stored) + 2 * tier_level(highest)
    return min(90, max(1, raw))


def current_requirement(base_requirement: int, affixes: list[dict]) -> int:
    """Ordinary item path only; unique, set and legendary have separate branches."""
    return max(base_requirement, affix_requirement(affixes), 1)


def with_affix_requirement(
    base_requirement: int, affixes: list[dict], affix_id: int, target_stored_tier: int
) -> int:
    # Native code includes the hypothetical target unconditionally. It filters
    # only the other existing affixes; eligibility must be checked separately.
    tiers = [target_stored_tier]
    tiers.extend(
        affix["displayTier"] - 1
        for affix in affixes
        if affix["id"] != affix_id and contributes(affix)
    )
    raw = -10 + sum(map(tier_level, tiers)) + 2 * tier_level(max(tiers))
    return max(base_requirement, min(90, raw), 1)


def after_shard_requirement(
    base_requirement: int, affixes: list[dict], affix_id: int, tiers_to_add: int = 1
) -> int:
    # The Find predicate is a separate native closure: ID AND Standard/unsealed.
    existing = next((affix for affix in affixes if affix["id"] == affix_id and contributes(affix)), None)
    target = existing["displayTier"] - 1 + tiers_to_add if existing else 0
    return with_affix_requirement(base_requirement, affixes, affix_id, target)


def max_stored_tier_for_level(
    base_requirement: int, affixes: list[dict], affix_id: int, player_level: int
) -> int:
    for stored_tier in range(6, 0, -1):
        if with_affix_requirement(base_requirement, affixes, affix_id, stored_tier) <= player_level:
            return stored_tier
    # Mirrors native sentinel/default behavior; this does not prove T1 is legal.
    return 0


def has_shard(definition: dict) -> bool:
    return (
        definition["rollsOn"] == 0
        and definition["specialAffixType"] in (0, 3)
        and definition["canRollOn"] != [41]
    )


def reference_value(example: dict) -> int | bool:
    operation = example["operation"]
    if operation == "hasShard":
        return has_shard(example["definition"])
    base = example["baseRequirement"]
    affixes = example["affixes"]
    if operation == "current":
        return current_requirement(base, affixes)
    if operation == "withAffix":
        return with_affix_requirement(base, affixes, example["affixId"], example["targetStoredTier"])
    if operation == "afterShard":
        return after_shard_requirement(base, affixes, example["affixId"], example.get("tiersToAdd", 1))
    if operation == "maxStoredTier":
        return max_stored_tier_for_level(base, affixes, example["affixId"], example["playerLevel"])
    raise ValueError(f"Unknown reference operation: {operation}")


def native_slice(raw: bytes, rva: int, length: int) -> bytes:
    """Minimal read-only PE32/PE32+ section mapping; no third-party dependency."""
    pe_offset = struct.unpack_from("<I", raw, 0x3C)[0]
    if raw[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise ValueError("Not a PE file")
    section_count = struct.unpack_from("<H", raw, pe_offset + 6)[0]
    optional_size = struct.unpack_from("<H", raw, pe_offset + 20)[0]
    table = pe_offset + 24 + optional_size
    for index in range(section_count):
        offset = table + index * 40
        virtual_size, start_rva, raw_size, raw_offset = struct.unpack_from("<IIII", raw, offset + 8)
        if start_rva <= rva < start_rva + max(virtual_size, raw_size):
            delta = rva - start_rva
            if delta + length > raw_size:
                raise ValueError(f"RVA {rva:#x} extends beyond section raw bytes")
            return raw[raw_offset + delta : raw_offset + delta + length]
    raise ValueError(f"Unmapped RVA {rva:#x}")


def verify_native(claims: dict, game_dir: Path) -> dict:
    raw = (game_dir / "GameAssembly.dll").read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != claims["source"]["gameAssemblySha256"]:
        raise ValueError("Installed GameAssembly.dll differs from audited build")
    metadata = game_dir / "Last Epoch_Data" / "il2cpp_data" / "Metadata" / "global-metadata.dat"
    if hashlib.sha256(metadata.read_bytes()).hexdigest() != claims["source"]["metadataSha256"]:
        raise ValueError("Installed global metadata differs from audited build")
    for method in claims["methods"]:
        block = native_slice(raw, int(method["rva"], 16), method["auditedSpanLength"])
        if hashlib.sha256(block).hexdigest() != method["sha256"]:
            raise ValueError(f"Native bytes changed: {method['name']}")
    for table in claims["jumpTables"]:
        block = native_slice(raw, int(table["rva"], 16), 4 * len(table["targetRvas"]))
        values = [hex(value) for value in struct.unpack(f"<{len(table['targetRvas'])}I", block)]
        if values != table["targetRvas"] or hashlib.sha256(block).hexdigest() != table["sha256"]:
            raise ValueError(f"Native jump table changed: {table['id']}")
    for constant in claims["constants"]:
        value = struct.unpack("<f", native_slice(raw, int(constant["rva"], 16), 4))[0]
        if value != constant["float32"]:
            raise ValueError(f"Native float changed: {constant['id']}")
    return {"methodsChecked": len(claims["methods"]), "tablesChecked": len(claims["jumpTables"]), "constantsChecked": len(claims["constants"])}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, help="Optional audited local game directory; verifies current native bytes")
    parser.add_argument("--verify-only", action="store_true", help="Verify committed examples without writing a report")
    parser.add_argument("--summary", action="store_true", help="Print a compact single-line JSON summary")
    parser.add_argument("--output", type=Path, help="Write deterministic validation JSON (UTF-8, LF)")
    args = parser.parse_args()
    claims = json.loads(CLAIMS.read_text(encoding="utf-8"))
    checked = []
    for example in claims["referenceExamples"]:
        actual = reference_value(example)
        if actual != example["expected"]:
            raise AssertionError(f"{example['id']}: got {actual!r}, expected {example['expected']!r}")
        checked.append({"id": example["id"], "actual": actual})
    # Snapshot HasShard uses the same definition fields as the native property.
    affixes = json.loads((ROOT / "data/game/1.5.3/affixes.json").read_text(encoding="utf-8"))["affixes"]
    shard_counts = {
        "all": sum(has_shard(affix["definition"]) for affix in affixes),
        "experimental": sum(has_shard(affix["definition"]) for affix in affixes if affix["definition"]["specialAffixType"] == 1),
    }
    if shard_counts != claims["snapshotChecks"]["hasShardCounts"]:
        raise AssertionError("Current committed HasShard snapshot counts differ")
    native = verify_native(claims, args.game_dir) if args.game_dir else None
    result = {
        "passed": True,
        "exampleCount": len(checked),
        "examples": checked,
        "snapshotShardCounts": shard_counts,
        "nativeVerification": native,
        "clientExperiment": False,
        "claimsSha256": hashlib.sha256(CLAIMS.read_bytes()).hexdigest(),
    }
    if args.output and not args.verify_only:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    if args.summary:
        print(json.dumps({key: result[key] for key in ("passed", "exampleCount", "snapshotShardCounts", "nativeVerification", "clientExperiment")}, separators=(",", ":")))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
