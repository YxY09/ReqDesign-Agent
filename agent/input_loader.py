"""输入处理模块：读取、清洗、分段需求文档"""

import os
import json
import logging

logger = logging.getLogger("reqdesign")


class InputLoader:
    """读取并清洗需求文档"""

    SUPPORTED_EXTENSIONS = {".md", ".txt", ".json"}
    MAX_FILE_SIZE = 512 * 1024  # 512KB
    MAX_CHARS = 100_000  # 最大字符数（防止零宽字符攻击）

    def __init__(self):
        pass

    def load(self, file_path: str) -> str:
        """读取需求文档，返回清洗后的文本"""
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"输入文件不存在: {file_path}")
        if os.path.isdir(file_path):
            raise ValueError(f"输入路径是目录而非文件: {file_path}")

        file_size = os.path.getsize(file_path)
        if file_size > self.MAX_FILE_SIZE:
            raise ValueError(f"文件过大: {file_size} bytes，上限 {self.MAX_FILE_SIZE} bytes")

        ext = os.path.splitext(file_path)[1].lower()
        if ext not in self.SUPPORTED_EXTENSIONS:
            raise ValueError(f"不支持的文件格式: {ext}，支持: {self.SUPPORTED_EXTENSIONS}")

        logger.info(f"读取需求文档: {file_path}")

        raw_content = self._read_file(file_path)

        if not raw_content.strip():
            raise ValueError("输入文件为空")

        if len(raw_content) > self.MAX_CHARS:
            raise ValueError(f"文件内容过长: {len(raw_content)} 字符，上限 {self.MAX_CHARS} 字符")

        if ext == ".json":
            return self._load_json(raw_content)
        else:
            return self._load_text(raw_content)

    @staticmethod
    def _read_file(file_path: str) -> str:
        """读取文件，自动尝试多种编码"""
        for encoding in ("utf-8", "gbk", "latin-1"):
            try:
                with open(file_path, "r", encoding=encoding) as f:
                    content = f.read()
                # 二进制内容检测：非打印字符占比过高
                if content:
                    non_printable = sum(
                        1 for c in content
                        if not c.isprintable() and c not in "\n\r\t"
                    )
                    if non_printable / len(content) > 0.3:
                        raise ValueError(
                            f"文件 {file_path} 可能是二进制文件，"
                            f"非打印字符占比 {non_printable/len(content):.0%}"
                        )
                return content
            except (UnicodeDecodeError, UnicodeError):
                continue
        # 最终兜底：替换无法解码的字符
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def _load_json(self, content: str) -> str:
        """从JSON中提取需求文本"""
        try:
            data = json.loads(content)
            if isinstance(data, str):
                return self.clean(data)
            if isinstance(data, dict):
                # 尝试常见的字段名
                for key in ("requirements", "content", "description", "text"):
                    if key in data:
                        return self.clean(str(data[key]))
                # 如果没有匹配字段，将整个JSON转为文本
                return self.clean(json.dumps(data, ensure_ascii=False, indent=2))
            return self.clean(str(data))
        except json.JSONDecodeError:
            return self.clean(content)

    def _load_text(self, content: str) -> str:
        """读取纯文本/Markdown"""
        return self.clean(content)

    def clean(self, text: str) -> str:
        """清洗文本：去除多余空白、标准化换行"""
        # 去除首尾空白
        text = text.strip()
        # 将多个连续空行合并为两个换行
        lines = text.split("\n")
        cleaned_lines = []
        prev_empty = False
        for line in lines:
            stripped = line.rstrip()
            if not stripped:
                if not prev_empty:
                    cleaned_lines.append("")
                prev_empty = True
            else:
                cleaned_lines.append(stripped)
                prev_empty = False
        result = "\n".join(cleaned_lines).strip()
        logger.debug(f"文本清洗完成，长度: {len(result)} 字符")
        return result

    def split_sections(self, text: str) -> list[dict]:
        """将需求文档按标题分段（忽略代码块内的#行）"""
        sections = []
        current_title = ""
        current_content = []
        in_code_fence = False

        for line in text.split("\n"):
            stripped = line.strip()
            # 跟踪代码围栏状态
            if stripped.startswith("```"):
                in_code_fence = not in_code_fence
                current_content.append(line)
                continue

            if not in_code_fence and line.startswith("#"):
                # 保存上一个段落
                if current_content or current_title:
                    content = "\n".join(current_content).strip()
                    if content:
                        sections.append({
                            "title": current_title,
                            "content": content,
                        })
                current_title = line.lstrip("#").strip()
                current_content = []
            else:
                current_content.append(line)

        # 保存最后一个段落
        if current_content or current_title:
            content = "\n".join(current_content).strip()
            if content:
                sections.append({
                    "title": current_title,
                    "content": content,
                })

        logger.info(f"文档分段完成，共 {len(sections)} 个段落")
        return sections
