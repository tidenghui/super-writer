# 子项目

| 包 | 职责 | 依赖 |
|---|---|---|
| `contract/` | 一本书的文件格式与读写 | 无 |
| `writer/` | 出题、章纲、章节流水线、批评家、归档 | contract |
| `reader/` | 阅读器、目录、RSS、统计 | contract |

**边界**：写手只写 `books/`，阅读器只读 `books/`。两者不互相 import。
