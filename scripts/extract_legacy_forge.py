"""Reproduce the pinned CanForgeOnItem existing-affix compatibility exception.

Reads the installed native DLL and metadata directly, with no cache, network,
third-party package or client execution. This is deliberately a fingerprinted
1.5.3 extractor, not a general-purpose IL2CPP metadata parser.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "research/legacy-forge-compatibility.json"
DLL_SHA = "323e9183f3bee600b6c9e1c469218b9de926e9044f2ca3d44fae8a0ec9a91464"
META_SHA = "2a4e8440606c420345934158b6784d8f5d8b0184f32fd91af0e9e0903ba94f83"
AFFIX_SHA = "abdbea6ee8a01e02f16122943da57bf641a504a3ece3fa05ffd1550c1cc79794"
METHODS = (
    ("canForge", "Affix.CanForgeOnItem", 0x11B1660, 188,
     "196479eda47bd6f8183ad93fe2e4a6b2c1881605df6c1f7c7ac9d86caa747ff1"),
    ("canRoll", "Affix.CanRollOn(int,int,ClassRequirement)", 0x11B19B0, 301,
     "6f1c8d134ba61baae027515858bd6554afa327c59ad6095a4baae7b953ab5650"),
    ("attributeInitializer", "SwapAttributesItemContainer..cctor", 0x14805F0, 140,
     "5b18efbf94753388321af21d549dfbc36ba1438c6fd6f99eea7ac9be84c1b009"),
    ("isAttribute", "SwapAttributesItemContainer.IsAttribute(ushort)", 0x1480570, 115,
     "5bf57686e540fd8e7a3002ac74943f760cf4179ad2aa536b6454db55a90410ed"),
    ("contains", "System.Linq.Enumerable.Contains<T> shared native implementation", 0x84CBE0, 492,
     "c9a971bdaaa68486ecefb808ecf41cf8fcc4ac90bda1d6dcc8c782f44a8d74a9"),
    ("compatibilityCall", "CheckForgeCapability compatibility call-site fragment", 0x1167E3F, 120,
     "df6b75b481b3b7b7485110cbfd33c47e154301586a934e76be0cafd6eae5f306"),
    ("classMatch", "EpochExtensions.MatchesSpecificity", 0x10E3D70, 74,
     "5c4139a93570c0fce2166674a3a8b894eb615e5cd5dba4155e2b0eb0c71d9bc3"),
    ("subtypeGroup", "SubTypeGroupExtensionMethods.GetSubTypeGroup", 0x1247030, 64,
     "0f941d08cb4257ed04ecc2d1c46b014f0280faeb19014dda170ba02549f57e52"),
    ("subtypeCompatibility", "SubTypeGroupExtensionMethods.CanRollOn", 0x1246F80, 175,
     "3a1a63952bdc1fb7595bfdaa3aa5dede5a1483e644ba1aef2999b9fd47103a15"),
    ("reroll", "ItemData.rerollAffixIDOfAffix", 0x1212A10, 1465,
     "d70d73e0a024e5fee7be2dd7e8ae272a8eaf2fc1b0fb9fa10ca2d4888a443003"),
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class PE:
    """Only the PE32+ file-backed section mapping required by this extractor."""

    def __init__(self, data: bytes):
        self.data = data
        header = struct.unpack_from("<I", data, 0x3C)[0]
        require(data[:2] == b"MZ" and data[header:header + 4] == b"PE\0\0", "Invalid PE")
        machine, count = struct.unpack_from("<HH", data, header + 4)
        optional_size = struct.unpack_from("<H", data, header + 20)[0]
        optional = header + 24
        require(machine == 0x8664 and struct.unpack_from("<H", data, optional)[0] == 0x20B,
                "Expected x64 PE32+")
        self.base = struct.unpack_from("<Q", data, optional + 24)[0]
        self.sections = []
        for i in range(count):
            offset = optional + optional_size + i * 40
            virtual_size, rva, raw_size, raw = struct.unpack_from("<IIII", data, offset + 8)
            self.sections.append((rva, max(virtual_size, raw_size), raw, raw_size))

    def offset(self, rva: int, length: int = 1) -> int:
        for start, size, raw, raw_size in self.sections:
            if start <= rva < start + size:
                delta = rva - start
                require(0 <= length <= raw_size - delta, "RVA not entirely file-backed")
                return raw + delta
        raise ValueError(f"Unmapped RVA {rva:#x}")

    def bytes(self, rva: int, length: int) -> bytes:
        offset = self.offset(rva, length)
        return self.data[offset:offset + length]

    def unpack(self, rva: int, fmt: str) -> tuple:
        return struct.unpack(fmt, self.bytes(rva, struct.calcsize(fmt)))

    def relative(self, rva: int, prefix: bytes) -> int:
        require(self.bytes(rva, len(prefix)) == prefix, f"Unexpected instruction at {rva:#x}")
        displacement = self.unpack(rva + len(prefix), "<i")[0]
        return rva + len(prefix) + 4 + displacement


class Metadata:
    def __init__(self, data: bytes):
        self.data = data
        self.header = struct.unpack_from("<95I", data)
        require(self.header[:2] == (0xFAB11BAF, 39), "Expected audited metadata v39")

    def row(self, table: int, index: int, size: int) -> int:
        start, byte_count, count = self.header[table:table + 3]
        require(byte_count == count * size and 0 <= index < count, "Invalid metadata row")
        return start + index * size

    def string(self, index: int) -> str:
        start, size = self.header[8:10]
        require(0 <= index < size, "Invalid metadata string offset")
        pos = start + index
        end = self.data.find(b"\0", pos, start + size)
        require(end >= pos, "Unterminated metadata string")
        return self.data[pos:end].decode("utf-8")

    def type_name(self, index: int) -> str:
        name, namespace = struct.unpack_from("<II", self.data, self.row(59, index, 82))
        return ".".join(filter(None, (self.string(namespace), self.string(name))))

    def fields(self, index: int) -> tuple[int, int]:
        offset = self.row(59, index, 82)
        return (struct.unpack_from("<i", self.data, offset + 26)[0],
                struct.unpack_from("<H", self.data, offset + 62)[0])

    def field(self, index: int) -> dict:
        name, type_index, token = struct.unpack_from("<III", self.data, self.row(35, index, 12))
        return {"fieldIndex": index, "name": self.string(name), "typeIndex": type_index,
                "token": hex(token)}

    def default(self, index: int) -> dict:
        matches = []
        for ordinal in range(self.header[25]):
            field, type_index, data_index = struct.unpack_from(
                "<iii", self.data, self.row(23, ordinal, 12))
            if field == index:
                matches.append({"rowIndex": ordinal, "fieldIndex": field,
                                "typeIndex": type_index, "dataIndex": data_index})
        require(len(matches) == 1, f"Expected one field default for {index}")
        return matches[0]


def extract(game: Path) -> dict:
    dll = (game / "GameAssembly.dll").read_bytes()
    metadata = (game / "Last Epoch_Data/il2cpp_data/Metadata/global-metadata.dat").read_bytes()
    require(sha(dll) == DLL_SHA and sha(metadata) == META_SHA,
            "Installed DLL/metadata changed: a new code audit is required")
    manifest = (game.parents[1] / "appmanifest_899770.acf").read_text(encoding="utf-8")
    build = re.search(r'"buildid"\s+"(\d+)"', manifest)
    require(build is not None and int(build[1]) == 26087601, "Steam build differs")
    affix_data = (ROOT / "data/game/1.5.3/affixes.json").read_bytes()
    require(sha(affix_data) == AFFIX_SHA, "Affix snapshot differs")
    affixes = {row["id"]: row["definition"] for row in json.loads(affix_data)["affixes"]}
    pe, meta = PE(dll), Metadata(metadata)
    methods = []
    for identity, name, rva, length, expected in METHODS:
        actual = sha(pe.bytes(rva, length))
        require(actual == expected, f"Native span changed: {name}")
        methods.append({"id": identity, "name": name, "rva": hex(rva), "length": length,
                        "fileOffset": pe.offset(rva, length), "sha256": actual,
                        "scope": "fragment" if identity == "compatibilityCall" else "method"})

    # Resolve encoded IL2CPP usages through this binary's registration tables.
    types_count, types_va = pe.unpack(0x4A3B4B0, "<QQ")

    def native_type(index: int) -> tuple[int, int]:
        require(0 <= index < types_count, "Invalid native type index")
        pointer = pe.unpack(types_va - pe.base + index * 8, "<Q")[0]
        return pe.unpack(pointer - pe.base, "<QI")

    def usage(slot: int, kind: int) -> int:
        encoded = pe.unpack(slot, "<Q")[0]
        require(encoded >> 29 == kind, "Unexpected encoded metadata usage kind")
        return (encoded & 0x1FFFFFFF) >> 1

    class_slot = pe.relative(0x11B16C2, b"\x48\x8b\x0d")
    require(class_slot == pe.relative(0x1480650, b"\x48\x8b\x0d"), "Different static class")
    class_type_index = usage(class_slot, 1)
    class_definition, _ = native_type(class_type_index)
    require(meta.type_name(class_definition) == "SwapAttributesItemContainer", "Unexpected class")
    first, count = meta.fields(class_definition)
    fields = [meta.field(i) for i in range(first, first + count)]
    require(fields[-1]["name"] == "AttributeIds", "Unexpected first static array field")
    constants = []
    for field in fields[:-1]:
        default = meta.default(field["fieldIndex"])
        value = struct.unpack_from("<H", metadata, meta.header[26] + default["dataIndex"])[0]
        constants.append({"name": field["name"], "id": value})

    require(pe.bytes(0x1480631, 1) == b"\xba", "Expected array length immediate")
    length = pe.unpack(0x1480632, "<I")[0]
    array_slot = pe.relative(0x148062A, b"\x48\x8b\x0d")
    element_pointer, array_bits = native_type(usage(array_slot, 1))
    element_data, element_bits = pe.unpack(element_pointer - pe.base, "<QI")
    require((array_bits >> 16) & 0xFF == 0x1D and (element_bits >> 16) & 0xFF == 7,
            "Expected SZARRAY of UInt16")
    require(meta.type_name(element_data) == "System.UInt16", "Unexpected array element")
    field_slot = pe.relative(0x148063B, b"\x48\x8b\x15")
    ref_index = usage(field_slot, 4)
    ref_type, relative_field = struct.unpack_from("<ii", metadata, meta.row(68, ref_index, 8))
    blob_type, _ = native_type(ref_type)
    require(meta.type_name(blob_type) == "<PrivateImplementationDetails>", "Unexpected blob owner")
    blob_first, blob_count = meta.fields(blob_type)
    require(0 <= relative_field < blob_count, "Invalid relative field index")
    blob_field = meta.field(blob_first + relative_field)
    default = meta.default(blob_field["fieldIndex"])
    blob_offset = meta.header[26] + default["dataIndex"]
    blob = metadata[blob_offset:blob_offset + length * 2]
    require(len(blob) == length * 2 and blob_field["name"].lower() == sha(blob),
            "Compiler blob field name does not match initializer bytes")
    ids = list(struct.unpack(f"<{length}H", blob))
    require(ids == [501, 502, 503, 504], "Table changed; re-audit the compatibility rule")

    # Resolve the metadata method name at the call, rather than guessing from
    # an address or mistaking the declared five constants for initialized data.
    contains_slot = pe.relative(0x11B16EE, b"\x4c\x8b\x05")
    method_ref = usage(contains_slot, 6)
    spec_count, specs_va = pe.unpack(0x4A3B4C0, "<QQ")
    require(0 <= method_ref < spec_count, "Invalid method specification")
    method_definition, class_inst, method_inst = pe.unpack(
        specs_va - pe.base + method_ref * 12, "<iii")
    method_offset = meta.row(17, method_definition, 32)
    method_name_index = struct.unpack_from("<I", metadata, method_offset)[0]
    declaring_type = struct.unpack_from("<H", metadata, method_offset + 4)[0]
    require(meta.string(method_name_index) == "Contains", "Expected Contains method")
    require(meta.type_name(declaring_type) == "System.Linq.Enumerable", "Unexpected Contains owner")
    for call, target in ((0x11B16B0, 0x11B19B0), (0x11B16FD, 0x84CBE0),
                         (0x148064B, 0x2A48C20), (0x1167E48, 0x1210850),
                         (0x1167E94, 0x11B1660), (0x1167EAA, 0x12106C0),
                         (0x1212D6B, 0x11B19B0), (0x1212E5D, 0x11B19B0)):
        require(pe.relative(call, b"\xe8") == target, f"Call target changed: {call:#x}")

    resources = []
    for identity in [*ids, 505]:
        definition = affixes[identity]
        resources.append({"id": identity, "inExistingAffixOverride": identity in ids,
                          **{key: definition[key] for key in (
                              "affixName", "type", "specialAffixType", "rollsOn",
                              "classSpecificity", "canRollOn", "levelRequirement")}})
    truth_table = [{"naturalCompatible": False, "alreadyOnItem": present, "affixId": identity,
                    "canForgeCompatibility": present and identity in ids}
                   for identity in [*ids, 505] for present in (False, True)]
    truth_table += [{"naturalCompatible": True, "alreadyOnItem": present, "affixId": 505,
                     "canForgeCompatibility": True} for present in (False, True)]
    return {
        "schemaVersion": 1, "auditDate": "2026-11-03", "gameVersion": "1.5.3",
        "steamBuildId": 26087601, "confidence": "VERIFIED",
        "verificationMethod": "Static control-flow and initialized-data extraction from pinned local native DLL and metadata; not a client experiment.",
        "sources": {"GameAssembly.dll": {"sha256": DLL_SHA, "bytes": len(dll)},
                    "Last Epoch_Data/il2cpp_data/Metadata/global-metadata.dat": {
                        "sha256": META_SHA, "bytes": len(metadata), "metadataVersion": 39},
                    "data/game/1.5.3/affixes.json": {"sha256": AFFIX_SHA, "bytes": len(affix_data)}},
        "methodEvidence": methods,
        "initializedTable": {
            "owner": "SwapAttributesItemContainer", "field": "AttributeIds", "elementType": "System.UInt16",
            "ids": ids, "length": length, "declaredConstants": constants,
            "notIncludedDeclaredConstantIds": [row["id"] for row in constants if row["id"] not in ids],
            "classTypeInfoSlotRva": hex(class_slot), "nativeClassTypeIndex": class_type_index,
            "classTypeDefinitionIndex": class_definition, "arrayTypeInfoSlotRva": hex(array_slot),
            "initializerFieldInfoSlotRva": hex(field_slot), "fieldRefIndex": ref_index,
            "fieldRefTypeIndex": ref_type, "fieldRefRelativeFieldIndex": relative_field,
            "initializerOwnerTypeDefinitionIndex": blob_type, "initializerField": blob_field,
            "fieldDefault": default, "metadataFileOffset": blob_offset,
            "byteLength": len(blob), "bytesHex": blob.hex(), "sha256": sha(blob),
            "containsMetadata": {"slotRva": hex(contains_slot), "methodSpecIndex": method_ref,
                                 "methodDefinitionIndex": method_definition, "name": "Contains",
                                 "declaringTypeDefinitionIndex": declaring_type,
                                 "declaringTypeName": meta.type_name(declaring_type),
                                 "classInstantiationIndex": class_inst, "methodInstantiationIndex": method_inst}},
        "rule": {
            "expression": "CanRollOn(baseType, subType, baseClassRequirement) || (affixAlreadyOnItem && existingAttributeOverrideIds.has(affixId))",
            "existingAttributeOverrideIds": ids,
            "alreadyOnItemSource": "ItemData.hasAffix(selectedShardAffixId), passed by CheckForgeCapability at 0x1167e94; sealed-affix rejection follows at 0x1167eaa.",
            "naturalCompatibility": {
                "uses": ["actual base equipmentType", "actual base subType", "actual base classRequirement"],
                "classMatch": "req==31 || specificity==0 || (req==0 && (specificity&1)!=0) || (((req<<1)&specificity)!=0)",
                "equipmentMatch": "canRollOn includes actual equipmentType OR the supported subtype-group fallback",
                "subtypeGroup": "equipmentType29/30 and subType in 10..14 or17 => group1/2; otherwise0",
                "subtypeGroupMatch": "group1 accepts canRollOn containing31 or33; group2 accepts32 or33"},
            "doesNotOverride": ["FP and item-category eligibility", "player-level gate", "sealed-slot rejection",
                                "maximum craftable tier", "prefix/suffix free capacity", "glyph-specific requirements"],
            "candidatePoolBoundary": "New IDs get no override because alreadyOnItem=false. Redemption/Chaos candidate enumeration calls CanRollOn directly (0x1212d6b and 0x1212e5d), with its other pool restrictions unchanged."},
        "affixResourceProjection": resources, "compatibilityTruthTable": truth_table,
        "limitations": ["Only this audited native build is supported by this extractor.",
                        "The term legacy is an audit label, not an inferred age or provenance requirement in the native branch.",
                        "This compatibility predicate alone does not establish whether a complete crafting action is legal.",
                        "No PRNG approximation, probability estimate, client execution or client measurement is involved."],
        "reproduce": "python -X utf8 scripts/extract_legacy_forge.py --game-dir <installed-game> --verify-only",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path,
                        default=Path(r"C:\Program Files (x86)\Steam\steamapps\common\Last Epoch"))
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    result = extract(args.game_dir)
    encoded = (json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    if args.verify_only:
        require(args.output.read_bytes() == encoded, "Recorded compatibility evidence differs from fresh extraction")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(encoded)
    print(f"{'verified' if args.verify_only else 'extracted'}: 1.5.3/build26087601; "
          f"AttributeIds={result['initializedTable']['ids']}; 505 excluded; "
          f"{len(METHODS)} native spans; {len(result['compatibilityTruthTable'])} predicate examples")


if __name__ == "__main__":
    main()
