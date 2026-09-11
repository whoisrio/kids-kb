"""分块、拆条、向量化入库与检索。

入库侧：docx_ingest / text_ingest 直接吃文本，structure / structure_exam / flat 负责拆条，
embed / lexical 负责分块与向量化；rerank 是供 internal_api 调用的检索服务。
"""
