"""Reproduce the audited initial-FP model; optional read-only installed-byte checks.

The ordinary-generation PMF is not a universal prior for ritual/empowered items.
No game code is executed. Native finite-grid rows assume independent uniform RNG
words, and are not a proof about PRNG correlations or online frequencies.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "research/fp-generation-20261103.json"
EXTENDED = [
    {"name": "SimilarItemExtensions::GetSimilarItem", "rva": "0x1240e80", "length": 12442,
     "sha256": "ee37981ac0542eecfdc4bee1e87853b193a354c55ba7b78619e2ca9f8fa90a83"},
    {"name": "RollForgingPotentialToAdd", "rva": "0x1231df0", "length": 195,
     "sha256": "1bf418e8c2c477e533b078d57439abef208c8bf4fa3d800327a210fa1655cd8e"},
]
NAMES = {
    "GenerateItems::rollForgingPotential", "GenerateItems::GenerateAffixes",
    "GenerateItems::RollAffixes", "GenerateItems::GenerateItemForRageOfMorditas",
    "ItemData::SetForgingPotential", "ItemData::RebuildID", "ItemData::setValuesFromSerialisation",
    "ItemData::EmpowerMagicRareOrExaltedCore", "ItemData::EmpowerMagicRareOrExaltedWithNemesis",
    "ItemData::EmpowerMagicRareOrExaltedWithRageOfMorditas", "RngElement.NextInt(int,int)",
    "RngElement.Roll(float)",
}
ENUMS = {
    "GenerationContext": {"Normal": 0, "Shop": 1, "Gambler": 2, "SoulGambler": 3, "Nemesis": 4, "RageOfMorditas": 5},
    "ForgingPotentialType": {"Default": 0, "Blood": 1, "Ice": 2},
}


def read(relative: str) -> dict:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def methods() -> list[dict]:
    rows = read("research/native-methods.json")["methods"] + read("research/additional-methods.json")["methods"]
    unique = {r["name"]: r for r in rows if r["name"] in NAMES}
    assert len(unique) == len(NAMES), set(NAMES) - unique.keys()
    return sorted(list(unique.values()) + EXTENDED, key=lambda r: int(r["rva"], 16))


def integer_pmf(lo: int, hi_exclusive: int, finite: bool) -> dict[int, Fraction]:
    n = hi_exclusive - lo
    assert n > 0
    if not finite:
        return {lo + k: Fraction(1, n) for k in range(n)}
    # NextInt uses the high 32 bits of U32 * n. Bucket k spans
    # ceil(k*2**32/n) .. ceil((k+1)*2**32/n)-1.
    size = 1 << 32
    ceildiv = lambda a, b: (a + b - 1) // b
    return {lo + k: Fraction(ceildiv((k + 1) * size, n) - ceildiv(k * size, n), size) for k in range(n)}


def roll_probability(finite: bool) -> Fraction:
    if not finite:
        return Fraction(11, 100)
    q = struct.unpack("<f", struct.pack("<f", .11))[0]
    return Fraction(math.floor(q * (1 << 23)) + 1, 1 << 23)


def initial_pmf(level: int, rarity: int, uncraftable: bool, context: int = 0, finite: bool = False) -> tuple[dict[int, Fraction], dict]:
    # Truncation toward zero agrees with the signed magic-division assembly;
    # all supported levels here are nonnegative.
    assert level >= 0
    t = level // 10
    if uncraftable:
        a, b = (35 + t, 40 + t) if rarity < 3 else (38 + t, 46 + t)
    elif rarity == 0:
        a, b = 24, 32
    elif rarity < 3:
        a, b = 22, 28
    else:
        a, b = 24 + t, 34 + t
    if context == 1:
        lo, hi = a // 2, (2 * (a // 3)) | 1
        pmf = integer_pmf(lo, hi, finite)
        branch = "Shop"
    elif context == 2:
        lo, hi = 3 * (a // 5), (4 * (a // 5)) | 1
        pmf = integer_pmf(lo, hi, finite)
        branch = "Gambler"
    else:
        lo, hi = 2 * (a // 3), b + 1
        q = roll_probability(finite)
        pmf = defaultdict(Fraction)
        for upper, weight in ((a + 1, 1 - q), (b + 1, q)):
            for f, p in integer_pmf(lo, upper, finite).items():
                pmf[f] += weight * p
        branch = "OrdinaryStyle (contexts 0/3/4/5)"
    assert sum(pmf.values()) == 1
    return dict(sorted(pmf.items())), {"a": a, "b": b, "branch": branch, "minimum": lo, "maximum": max(pmf)}


def summary(pmf: dict[int, Fraction]) -> dict:
    def quantile(q: Fraction) -> int:
        total = Fraction()
        for f, p in sorted(pmf.items()):
            total += p
            if total >= q:
                return f
        raise AssertionError("Bad PMF")
    mean = sum(f * p for f, p in pmf.items())
    return {"mean": float(mean), "meanFraction": str(mean),
            "quantiles": {f"P{q}": quantile(Fraction(q, 100)) for q in (10, 25, 50, 75, 90, 95, 99)},
            "pmf": {str(f): float(p) for f, p in sorted(pmf.items())},
            "pmfFractions": {str(f): str(p) for f, p in sorted(pmf.items())},
            "probabilityAbove48": float(sum(p for f, p in pmf.items() if f > 48)),
            "probabilityAtLeast50": float(sum(p for f, p in pmf.items() if f >= 50)),
            "probabilityAtLeast55": float(sum(p for f, p in pmf.items() if f >= 55))}


def result() -> dict:
    rows = []
    for label, level, rarity, uncraftable, context in [
        ("level100-exalted-core", 100, 4, True, 0),
        ("level90-exalted-core", 90, 4, True, 0),
        ("level85-exalted-core", 85, 4, True, 0),
        ("level100-rare-no-uncraftable", 100, 4, False, 0),
        ("level100-magic", 100, 2, False, 0),
        ("level100-normal", 100, 0, False, 0),
        ("level100-low-raw-rarity-exalted", 100, 2, True, 0),
        ("level100-exalted-shop-context", 100, 4, True, 1),
        ("level100-exalted-gambler-context", 100, 4, True, 2),
    ]:
        pmf, bounds = initial_pmf(level, rarity, uncraftable, context)
        native, _ = initial_pmf(level, rarity, uncraftable, context, finite=True)
        rows.append({"label": label, "generationLevel": level, "rawRarity": rarity,
                     "hasUncraftableAffixAtRoll": uncraftable, "context": context, **bounds,
                     "nominalIid": summary(pmf), "finiteGridIid": summary(native)})
    top = rows[0]
    assert top["nominalIid"]["meanFraction"] == "1011/25"
    assert top["nominalIid"]["quantiles"] == {"P10": 33, "P25": 36, "P50": 40, "P75": 45, "P90": 47, "P95": 48, "P99": 54}
    assert all(max(initial_pmf(100, 4, True, c)[0]) == 56 for c in (0, 3, 4, 5))
    return {"schemaVersion": 1, "auditedOn": "2026-11-03", "timezone": "Asia/Tokyo",
            "gameVersion": "1.5.3", "steamBuildId": 26087601,
            "sourceFiles": read("research/audited-build.json")["files"],
            "metadataDescriptor": {"relativePath": "MelonLoader/Dependencies/Il2CppAssemblyGenerator/Cpp2IL/cpp2il_out/LE.dll", "sha256": "90c158898682825116547d51b1c7a46e1b9eebd6822c4028ce5cbbe5a9066f19"},
            "methods": methods(), "enums": ENUMS,
            "expansionChance": {"float32": struct.unpack("<f", struct.pack("<f", .11))[0], "rva": "0x472932c", "nominal": .11, "finiteGridIid": float(roll_probability(True))},
            "modelInterpretation": "Derived from audited native instructions; independent RNG models, not gameplay sampling. 63 is persistence cap, not drop PMF. FP type is not GenerationContext.",
            "representativeStructures": [{"slots": s, "type": p, "primitivePmfRow": "level100-exalted-core", "scope": "Only the same level100 ordinary-style FP roll with rarity>=3, hasUncraftable=true; not a final ritual/empowered source prior"} for s in ([7,2,7,2], [7,1,7,0], [7,3,7,2]) for p in ("NORMAL", "BLOOD", "ICE")],
            "rows": rows, "clientExperiment": False}


def verify_installed(game: Path, report: dict) -> None:
    from extract_game_snapshot import read_installed
    from extract_legacy_forge import PE, Metadata
    read_installed(game, read("research/audited-build.json"))
    binary = (game / "GameAssembly.dll").read_bytes()
    pe = PE(binary)
    for row in report["methods"]:
        assert hashlib.sha256(pe.bytes(int(row["rva"], 16), row["length"])).hexdigest() == row["sha256"], row["name"]
    assert struct.unpack("<f", pe.bytes(0x472932c, 4))[0] == report["expansionChance"]["float32"]
    descriptor = report["metadataDescriptor"]
    assert hashlib.sha256((game / descriptor["relativePath"]).read_bytes()).hexdigest() == descriptor["sha256"]
    meta = Metadata((game / "Last Epoch_Data/il2cpp_data/Metadata/global-metadata.dat").read_bytes())
    seen = {}
    for i in range(meta.header[61]):
        name = meta.type_name(i)
        if name not in ENUMS:
            continue
        first, count = meta.fields(i)
        observed = {}
        for j in range(first, first + count):
            field = meta.field(j)
            if field["name"] == "value__":
                continue
            default = meta.default(j)
            # These pinned enum values are 0..5 and v39 stores each as a
            # single even compressed signed value. Check the bytes directly.
            encoded = meta.data[meta.header[26] + default["dataIndex"]]
            assert encoded == 2 * ENUMS[name][field["name"]]
            observed[field["name"]] = encoded // 2
        assert observed == ENUMS[name]
        seen[name] = observed
    assert seen == ENUMS


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    report = result()
    if args.game_dir:
        verify_installed(args.game_dir, report)
    if args.verify_only:
        assert read("research/fp-generation-20261103.json") == report
    else:
        OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "nativeChecked": bool(args.game_dir), "methods": len(report["methods"]), "rows": len(report["rows"]), "level100Exalted": {k: report["rows"][0]["nominalIid"][k] for k in ("mean", "quantiles")}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
