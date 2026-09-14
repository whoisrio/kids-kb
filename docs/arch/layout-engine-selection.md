# 版面解析引擎选型：PP-DocLayoutV3 vs Docling Layout

> 记录时间：2026-09。结论：**维持 PP-DocLayoutV3，无切换动机**。

## 结论

两者都是"检测框 + 分类"的版面检测器，架构同源（RT-DETR 系），但标签体系与训练数据取向差异大：
PP-DocLayoutV3 明显更贴合中文教辅/数学试卷场景；Docling 更偏英文商务/学术文档。
对当前架构（版面切块后接自家 OCR/VLM 分级解析），PP-DocLayoutV3 是更合适的选择。

## 逐项对比

### 模型架构与速度

- Docling：heron（默认，RT-DETRv2+ResNet-50，172MB）/ heron-101（ResNet-101，307MB，canonical DocLayNet 上 78% mAP，A100 28ms/图）/ egret-medium/large/xlarge（DFINE 系，78~251MB）。Transformers 推理，支持 CPU/CUDA/MPS/XPU；heron 另有 ONNX。
- PP-DocLayoutV3：同为 RT-DETR 系（PaddlePaddle），权重约 125MB。本项目实测 V2 ~5s/页、V3 约 7~8s/页（CPU、200dpi）。注意 Docling 默认喂 72dpi 页图，两边速度不能直接比。

### 标签集（对本场景最关键）

- Docling 基本是 DocLayNet 体系 17 类：Text/Table/Picture/Section-header/Formula（仅独立公式）/Caption/Footnote/页眉页脚/列表项/Code/Form 等。
- PP-DocLayout 25 类（映射见 `pipeline/kb/ocr/layout.py` 的 `_LABEL_MAP`），多出关键项：`inline_formula` 行内公式、`display_formula`、`seal` 印章、`vertical_text` 竖排、`algorithm`、`reference`。
- 数学教辅拆题对行内公式检测是硬需求，Docling 不区分行内/独立公式。

### 阅读顺序 / 多栏

- 两家都没有"先判栏数再分栏解析"的显式栏分割阶段。
- PP-DocLayoutV2/V3：阅读顺序由模型内嵌全局指针网络端到端预测，检测同时输出全文阅读位置；多栏、竖排、跨栏标题原生覆盖。本项目直接采用返回顺序作块 ordinal（`layout.py:166`）。
- Docling：阅读顺序靠后处理 `ReadingOrderPredictor` 纯规则空间聚类；多栏是其弱项（GitHub issue #2067 三栏财报串行错乱），第三方甚至出现 docberry 之类专门补双栏阅读顺序的包装层。
- 显式栏分割路线是 MinerU（检测后按栏切分再排序）与 Dolphin/GLM-OCR（anchor 区域两级解析）的做法。若将来真需要栏级中间产物，在检测框上做几何聚类（xy-cut）即可，不必换引擎。

### 训练数据取向

- Docling：DocLayNet + WordScape + 私有 DocLayNet-v2，共 15 万页，英文商务/学术/财报为主。
- PP-DocLayout：含大量中文杂志、试卷、论文、古籍竖排，中文教辅版式覆盖更好。

### 本地部署资源

- 模型本身都很轻（78~307MB，内存几百 MB 内），纯 CPU 可跑，输入缩到 640×640。
- 真正的成本在依赖栈：Docling 需要 torch + transformers（2-3GB 起步）；本项目已整套建在 paddlepaddle/paddleocr 上，引入第二套深度学习框架合计 5GB+ 依赖，只为替换一个"框+标签"环节，且标签粒度还变粗。

## Docling 的真实强项（与本项目的错位分析）

1. **工程化与生态**：MIT 协议、docling-serve 服务化、MCP/LangChain 集成、格式广度（PDF/docx/pptx/xlsx/HTML/图片统一进 DoclingDocument）。—— 本项目是自研私有管线，只需 PDF/docx/md，用不上。
2. **表格结构识别**：TableFormer + cell matching 回配 PDF 原生 token，字符错位率低；单项 SOTA 已被 MinerU2.5 超过但仍属第一梯队。—— 本项目 table 块目前只做裁图保留，不解析内部结构。
3. **PDF 原生通道**：数字原生 PDF 的 bbox 吸附真实文本 cell，坐标精度高。—— 本项目输入以扫描版教辅为主，用不上。
4. **可插拔模型矩阵**：各阶段多档模型，含 SmolDocling/Granite-Docling-258M 端侧整页模型。

## 可借鉴项（不换引擎前提下）

- **表格结构化**（若将来需要）：优先复用现有 VLM 渠道对 table 裁图做结构转录（与公式 VLM 转录同模式，零新增依赖）；需要高精度数字表格还原时才评估 TableFormer（`docling-ibm-models` 可独立安装）。
- **版面后处理规则**（heron 论文 §Post-processing）：检测框与底层文本 cell 对齐、重叠簇合并、整页 Picture 丢弃等规则，对复核页块质量优化有参考价值。
- **VLM 整页对照**：SmolDocling/Granite-Docling 的 DocTags 整页转换，可作为"一页一模型"轻量通道的对照实验（属 parse 链路替代，非 layout 替换）。

## 参考资料

- [Advanced Layout Analysis Models for Docling (arXiv 2509.11720)](https://arxiv.org/abs/2509.11720) — heron/egret 模型家族、17 类标签、性能数据
- [Docling Model Catalog](https://docling-project.github.io/docling/usage/model_catalog/) — 各阶段模型与推理引擎
- [Docling Technical Report (arXiv 2408.09869)](https://arxiv.org/html/2408.09869v4) — TableFormer、CPU 性能基线
- [docling issue #2067](https://github.com/docling-project/docling/issues/2067) — 多栏阅读顺序问题
- [PP-DocLayoutV3 阅读顺序机制](https://blog.gitcode.com/ef3d63325df1ffa2b86c375ca0b2434a.html) — 全局指针网络
- 模型权重体积实测自 HuggingFace API（docling-project/docling-layout-*）
