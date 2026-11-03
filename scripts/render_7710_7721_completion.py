"""Render every visible side/owned-tier class from the396case numeric record."""
from collections import defaultdict
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
data=json.loads((ROOT/'research/7710-7721-completion.json').read_text(encoding='utf-8'))
groups=defaultdict(lambda: defaultdict(list))
for row in data['cases']:
    tiers=row['slotTiers']
    p='/'.join('空' if t==0 else str(t) for t in sorted(tiers[:2],reverse=True))
    s='/'.join('空' if t==0 else str(t) for t in sorted(tiers[2:],reverse=True))
    goal={ (2,0):'双前缀',(1,1):'一前一后',(0,2):'双后缀'}[tuple(row['targetSides'])]
    owned='无' if row['existingGoalSlot'] is None else ('前缀' if row['existingGoalSlot'].startswith('前') else '后缀')+f"T{row['existingGoalTier']}"
    groups[(row['pattern'],p,s,goal,owned)][row['fpType']].append(row)

def cell(rows):
    values=[r['completion']['probability'] for r in rows if r['completion'] and r['completion']['probability']]
    if not values:
        return '未找到过门槛方案'
    lo=min((v['lower']+v['upper'])/2 for v in values)*100
    hi=max((v['lower']+v['upper'])/2 for v in values)*100
    value=f'{lo:.3f}%' if hi-lo<.0001 else f'{lo:.3f}–{hi:.3f}%'
    names={'RECOMMENDED':'推荐','NOT_RECOMMENDED':'不推荐','NEUTRAL':'中性','UNRESOLVED':'待定'}
    labels=sorted({names[r['completion']['recommendation']] for r in rows if r['completion']})
    return value+'（'+'／'.join(labels)+'）'

lines=['# 7710无目标与7721已有一目标：48FP全位置对照','',
       f"模型`{data['modelId']}`，起始48FP；成功平均FP超过65放弃。整件完成率低于25%不推荐、高于65%推荐，等号中性。",'',
       '## 计算范围','',
       '默认手套部位、普通Standard词缀、封印槽空、最终两个目标均普通槽T7。未提供具体身份，采用与简易UI一致的等权正权重参考池；等级按可锻造前提100。', '',
       '7710的12种四槽阶数排列×3种目标侧别×3潜能＝108例；7721的12种排列×4个已有目标位置×2种新目标侧别×3潜能＝288例，总396例。原生可见顺序全部保留。表格只合并同侧无名槽互换后的同类并给范围，不把合并后的标签作为完整Markov状态。', '',
       '使用生产48模板候选和原有操作成功率／FP排序，但本研究将每模板状态预算限定为512（网页默认25000），冻结时钟保证可复现。未算完的候选保持未完成。表中“推荐”证明存在一条已算路线通过标准；没有推荐或没有过门槛方案，不证明任何可能策略都不行。没有宣称全局最优或真实掉落分布。','',
       '下表全部是包含剥离／封印NG和FP耗尽的整件完成率，采用余额递推及零费用回路方程，不是由均值换算或Monte Carlo抽样。', '',
       '## 汇总','',
       '| 结构／已有目标 | 普通 | 冰 | 血 |','|---|---|---|---|']
for pattern,tier,label in [('7710',None,'7710，无目标'),('7721',7,'7721，已有目标在T7'),('7721',2,'7721，已有目标在T2'),('7721',1,'7721，已有目标在T1')]:
    cells=[]
    for fp in ['NORMAL','ICE','BLOOD']:
        summary=next(r for r in data['summaries'] if r['pattern']==pattern and r['existingGoalTier']==tier and r['fpType']==fp)
        cells.append(f"{summary['recommended']}/{summary['cases']}个位置有推荐见证")
    lines.append('| '+label+' | '+' | '.join(cells)+' |')
for pattern in ['7710','7721']:
    lines += ['',f'## {pattern}的全部侧别／目标位置结构','',
              '| 前缀T级 | 后缀T级 | 两个目标侧别 | 已有目标 | 普通完成率 | 冰完成率 | 血完成率 |',
              '|---|---|---|---|---:|---:|---:|']
    for (kind,p,s,goal,owned),rows in sorted(groups.items()):
        if kind==pattern:
            lines.append('| '+' | '.join([p,s,goal,owned]+[cell(rows[fp]) for fp in ['NORMAL','ICE','BLOOD']])+' |')
lines += ['', '## 结论边界','',
          '7710可直接补词／封T1的结构，普通68.343%、冰81.807%、血66.567%，均可推荐。需要额外调位时不能只凭7710标签保证推荐。', '',
          '7721已有目标在T7或T2且能直接封T1补另一目标时，可找到普通72.263%、冰83.724%、血73.928%的推荐见证。已有目标在T1的普通／血例，本次范围最高仅59.151%／61.321%，未达推荐；冰例最高75.814%。', '',
          '本次冰潜能7721全部位置均有推荐见证，其中最低65.004%仅略高于65%，需用未四舍五入的数值判定。网页在这种边界显示“>65%”，避免65.00%与推荐标签相冲突。', '',
          '[全部396例请求、路线ID和数值区间](../research/7710-7721-completion.json)。', '',
          '复现：`npx tsx scripts/research_7710_7721_completion.ts --verify-only`，然后`py -3.11 -X utf8 scripts/render_7710_7721_completion.py`。', '']
(ROOT/'docs/7710-7721-completion.md').write_text('\n'.join(lines),encoding='utf-8',newline='\n')
print(json.dumps({'cases':len(data['cases']),'displayClasses':len(groups),'modelId':data['modelId']}))
