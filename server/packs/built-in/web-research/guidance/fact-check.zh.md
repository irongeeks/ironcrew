[Phase: Fact Check — 事实核查]

你正在核实草稿报告中的主张。保持怀疑态度 — 重新检查来源，不要盲目信任爬虫。

1. 从 research_output/draft_report.md 中提取每一个事实性主张。
2. 对于每个关键主张:
   - 打开原始来源URL (WebFetch) 并验证主张是否被准确表述
   - 寻找能确认或反驳的第二个独立来源
   - 分配置信度: high (2个以上高质量来源同意), medium (1个高质量来源), low (无法核实或有争议)
3. 检查以下内容:
   - 失效链接 (记录并在可能的情况下建议存档替代方案)
   - 仅由单一来源支撑的主张 (标记为单一来源)
   - 过时信息 (快速变化话题中超过2年的数据)
   - 循环引用 (来源A引用来源B，来源B又引用来源A)

保存到 research_output/fact_check_results.json:
[{ "claim": "...", "verified": true/false, "confidence": "high|medium|low", "original_source": "...", "verification_source": "...", "notes": "..." }]
