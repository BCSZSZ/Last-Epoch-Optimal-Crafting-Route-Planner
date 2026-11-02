"""Print a verified method from the installed binary without importing old caches."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct

from extract_game_snapshot import ROOT, digest_file


def main() -> None:
    import pefile
    from capstone import Cs, CS_ARCH_X86, CS_MODE_64
    from capstone.x86 import X86_OP_IMM, X86_OP_MEM, X86_REG_RIP

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, required=True)
    parser.add_argument("--name", required=True, help="Regex matching exactly one registered method.")
    parser.add_argument("--evidence-file", type=Path, help="Optional reviewed supplemental method spans, including extended control-flow tails.")
    args = parser.parse_args()
    registry = json.loads((ROOT / "research/native-methods.json").read_text(encoding="utf-8"))
    if args.evidence_file:
        supplement = json.loads(args.evidence_file.read_text(encoding="utf-8"))
        registry = {"assemblySha256": supplement.get("assemblySha256", supplement.get("gameAssemblySha256")),
                    "methods": supplement["methods"]}
    binary_path = args.game_dir / "GameAssembly.dll"
    if digest_file(binary_path) != registry["assemblySha256"]:
        raise ValueError("Installed binary differs from the audited method registry.")
    matches = [method for method in registry["methods"] if re.search(args.name, method["name"])]
    if len(matches) != 1:
        raise ValueError(f"Expected one method, found {len(matches)}: {[(m['name'], m['rva']) for m in matches]}")
    method = matches[0]
    binary = binary_path.read_bytes()
    pe = pefile.PE(data=binary, fast_load=True)
    rva = int(method["rva"], 0)
    offset = pe.get_offset_from_rva(rva)
    payload = binary[offset:offset + method["length"]]
    if hashlib.sha256(payload).hexdigest() != method["sha256"]:
        raise ValueError("Method hash mismatch.")
    labels = {}
    for entry in registry["methods"]:
        labels.setdefault(int(entry["rva"], 0), []).append(entry["name"])
    decoder = Cs(CS_ARCH_X86, CS_MODE_64)
    decoder.detail = True
    base = pe.OPTIONAL_HEADER.ImageBase
    print(json.dumps(method, ensure_ascii=False))
    for instruction in decoder.disasm(payload, base + rva):
        notes = []
        for operand in instruction.operands:
            if operand.type == X86_OP_IMM and (instruction.mnemonic == "call" or instruction.mnemonic.startswith("j")):
                target = operand.imm - base
                notes.append(f"RVA {target:#x} " + " / ".join(labels.get(target, [])[:2]))
            elif operand.type == X86_OP_MEM and operand.mem.base == X86_REG_RIP:
                target = instruction.address + instruction.size + operand.mem.disp - base
                if instruction.mnemonic.endswith("ss"):
                    try:
                        position = pe.get_offset_from_rva(target)
                        notes.append(f"float32[{target:#x}]={struct.unpack_from('<f', binary, position)[0]!r}")
                    except (ValueError, struct.error, pefile.PEFormatError):
                        pass
        suffix = " ; " + " | ".join(notes) if notes else ""
        print(f"{instruction.address - base:08x}: {instruction.mnemonic:9s} {instruction.op_str}{suffix}")


if __name__ == "__main__":
    main()
