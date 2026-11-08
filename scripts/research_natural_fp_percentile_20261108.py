"""Recompute the natural exalted FP distribution and its discrete70th percentile.

Uses the audited FP roll primitive, not a fitted normal distribution or samples.
The100-level high-budget prior is not a final ritual/empowered-item distribution.
"""
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys
from research_fp_generation_20261103 import initial_pmf, summary
ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/'research/natural-fp-percentile-20261108.json'
def build():
    rows=[]
    for level in (85,90,100):
        for rarity in (2,4):
            pmf,bounds=initial_pmf(level,rarity,True)
            finite,_=initial_pmf(level,rarity,True,finite=True)
            def quantile(pmf):
                c=Fraction()
                for f,p in pmf.items():
                    c+=p
                    if c>=Fraction(7,10):return f
            q=quantile(pmf)
            rows.append(dict(generationLevel=level,ordinaryAffixes='1-2' if rarity<3 else '3-4',
                **bounds,mean=summary(pmf)['mean'],q70=q,finiteGridQ70=quantile(finite),
                cdfBeforeQ70=float(sum(p for f,p in pmf.items() if f<q)),
                cdfAtQ70=float(sum(p for f,p in pmf.items() if f<=q)),
                above48=float(sum(p for f,p in pmf.items() if f>48)),
                pmf=summary(pmf)['pmf'],pmfFractions=summary(pmf)['pmfFractions']))
    native=json.loads((ROOT/'research/natural-fp-native154-20261108.json').read_text('utf8'))
    assert native['status']=='PASS_CURRENT154_NATURAL_FP'
    target=rows[-1]
    assert target['mean']==40.44 and target['q70']==44
    assert Fraction(11,100)*Fraction(8,25)==Fraction(22,625)
    assert target['above48']==.0352
    return dict(schemaVersion=1,date='2026-11-08',basis='Audited1.5.3 roll primitive; same1.5.4 native instructions independently rechecked in course research.',
        model='DISPLAY_PARAMETERS_INDEPENDENT_DRAWS_V1',clientSampling=False,
        definition='Smallest integer f such that P(FP<=f)>=0.70',
        nativeEvidence='research/natural-fp-native154-20261108.json',
        nativeEvidenceSha256=hashlib.sha256((ROOT/'research/natural-fp-native154-20261108.json').read_bytes()).hexdigest(),
        source='scripts/research_fp_generation_20261103.py',
        sourceSha256=hashlib.sha256((ROOT/'scripts/research_fp_generation_20261103.py').read_bytes()).hexdigest(),
        recommendedDefaultFp=44,defaultScope='Level100 natural exalted with3-4 ordinary affixes, before crafting or source-specific FP modification',
        expansionBranchProbability=.11,probabilityAbove48=.0352,rows=rows)
if __name__=='__main__':
    data=build()
    if '--verify-only' in sys.argv:assert json.loads(OUTPUT.read_text('utf8'))==data
    else:OUTPUT.write_bytes((json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode('utf8'))
    print(json.dumps(dict(status='PASS_NATURAL_FP_Q70',defaultFp=data['recommendedDefaultFp'],mean=data['rows'][-1]['mean'],above48=data['probabilityAbove48'])))
